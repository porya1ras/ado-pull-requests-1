import * as vscode from 'vscode';
import * as GitInterfaces from 'azure-devops-node-api/interfaces/GitInterfaces';
import { AdoClient } from './adoClient';
import { PrNode } from './prTreeDataProvider';

export async function sendPrToUxMessageReview(node: PrNode): Promise<void> {
    const client = new AdoClient(node.orgUrl);

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Preparing PR for UX Message review…',
        cancellable: false,
    }, async (progress) => {
        try {
            // 1. Get latest iteration
            const iterations = await client.getPullRequestIterations(
                node.repoId, node.pr.pullRequestId!,
            );
            if (!iterations.length) {
                vscode.window.showWarningMessage('No iterations found for this PR.');
                return;
            }
            const latestId = iterations[iterations.length - 1].id!;

            // 2. Get changed files
            const changes = await client.getPullRequestIterationChanges(
                node.repoId, node.pr.pullRequestId!, latestId,
            );
            if (!changes.changeEntries?.length) {
                vscode.window.showWarningMessage('No changed files in this PR.');
                return;
            }

            // 3. Build diff summary
            const diffParts: string[] = [];
            const changedFiles: string[] = [];
            for (const entry of changes.changeEntries) {
                const e = entry as any;
                const path: string = e.item?.path ?? 'unknown';
                const objectId: string = e.item?.objectId ?? '';
                const changeType = changeTypeString(entry.changeType);

                changedFiles.push(`- ${changeType} ${path}`);
                diffParts.push(`### ${changeType} ${path}`);

                // Fetch content for edits so AI can see the code
                if (
                    entry.changeType !== undefined &&
                    (entry.changeType & GitInterfaces.VersionControlChangeType.Delete) === 0 &&
                    objectId
                ) {
                    try {
                        const content = await client.getFileContent(node.repoId, objectId);
                        // Limit to first 200 lines to avoid token overflow
                        const trimmed = content.split('\n').slice(0, 200).join('\n');
                        diffParts.push('```');
                        diffParts.push(trimmed);
                        diffParts.push('```');
                    } catch {
                        diffParts.push('_(content unavailable)_');
                    }
                }
                diffParts.push('');
            }

            const promptTemplate = `You are reviewing this Pull Request strictly for user-facing error message quality.

Your goal is to ensure all messages:
- Use UK English spelling and grammar
- Are clear to non-technical users
- Provide helpful guidance where appropriate
- Avoid blame, ambiguity, or unnecessary technical detail
- Follow a consistent tone across the application

Enforce these standards:
- Use plain English (avoid jargon like "null reference", "invalid state", etc.)
- Prefer actionable wording:
  BAD: "Invalid input"
  GOOD: "Please enter a valid email address"
- Avoid generic messages:
  BAD: "Something went wrong"
  GOOD: "We couldn't process your request. Please try again."
- Keep messages concise but informative
- Maintain consistent terminology across messages

Check for:
- American vs UK spelling
- Clarity and readability
- Actionability
- Tone consistency
- Missing user guidance

RULES (must follow):
1) Output MUST be valid JSON only. No markdown, no extra text.
2) Do NOT invent files, line numbers, functions, or context not present in the diff.
3) If information is missing, set fields to null and explain in "note".
4) Prefer actionable, minimal, high-signal feedback.
5) All comments must map to a specific diff location when possible. Use the provided severity levels exactly: "blocker" | "high" | "medium" | "low" | "nit".

OUTPUT SCHEMA (JSON):
{
  "meta": {
    "schemaVersion": "1.0",
    "prId": <number>,
    "summary": "A short summary of the review and final quality rating (1-10)",
    "overallRisk": "low" | "medium" | "high",
    "confidence": 0.0-1.0
  },
  "checks": {
    "bugs": { "status": "pass"|"warn"|"fail", "note": null },
    "security": { "status": "pass"|"warn"|"fail", "note": null },
    "performance": { "status": "pass"|"warn"|"fail", "note": null },
    "maintainability": { "status": "pass"|"warn"|"fail", "note": "Rating for clarity, readability, UK vs US spelling" },
    "tests": { "status": "pass"|"warn"|"fail", "note": null }
  },
  "comments": [
    {
      "id": "unique-id-string",
      "severity": "blocker"|"high"|"medium"|"low"|"nit",
      "category": "maintainability",
      "filePath": "path/to/file",
      "side": "RIGHT",
      "line": <number|null>,
      "startLine": <number|null>,
      "endLine": <number|null>,
      "title": "Title of the issue",
      "message": "Problem with user-facing message",
      "suggestion": "Improved user-friendly message suggestion",
      "rationale": "Why it improves tone/clarity"
    }
  ],
  "generalSuggestions": [
    { "title": "Final quality rating", "message": "Example details" }
  ]
}

PR CONTEXT:
PR Title:
{{PR_TITLE}}

PR ID:
{{PR_ID}}

PR Description:
{{PR_DESCRIPTION}}

Changed Files:
{{CHANGED_FILES}}

Diff:
{{DIFF}}`;

            const prompt = promptTemplate
                .replace('{{PR_TITLE}}', node.pr.title || '(none)')
                .replace('{{PR_DESCRIPTION}}', node.pr.description || '(none)')
                .replace('{{PR_ID}}', node.pr.pullRequestId?.toString() || '0')
                .replace('{{CHANGED_FILES}}', changedFiles.join('\n'))
                .replace('{{DIFF}}', diffParts.join('\n'));

            // 4. Send to background agent (vscode Language Model)
            try {
                progress.report({ message: 'Sending prompt to AI...', increment: 50 });

                // Workaround: ensure copilot-chat or similar extension is fully activated 
                const copilotExt = vscode.extensions.getExtension('github.copilot-chat');
                if (copilotExt && !copilotExt.isActive) {
                    await copilotExt.activate();
                }

                let models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
                if (!models || models.length === 0) {
                    models = await vscode.lm.selectChatModels();
                }

                if (!models || models.length === 0) {
                    throw new Error('No compatible AI chat model found. Please install/sign in to GitHub Copilot or an alternative.');
                }

                const model = models.find(m => m.family.includes('gpt-4') || m.family.includes('claude')) || models[0];

                const messages = [
                    vscode.LanguageModelChatMessage.User(prompt)
                ];

                const chatResponse = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
                let responseText = '';
                for await (const fragment of chatResponse.text) {
                    responseText += fragment;
                }

                progress.report({ message: 'Parsing AI response...', increment: 30 });
                const { extractReviewJson } = await import('./postReviewComments');
                const reviewPayload = extractReviewJson(responseText);

                // Show Webview
                const { ReviewWebviewPanel } = await import('./reviewWebview');
                ReviewWebviewPanel.createOrShow(node, reviewPayload);
            } catch (err) {
                vscode.window.showErrorMessage(`Error during AI review execution: ${err}`);
                await vscode.env.clipboard.writeText(prompt);
                vscode.window.showInformationMessage('Review prompt copied to clipboard due to failure. Opening chat panel...');

                try {
                    await vscode.commands.executeCommand('workbench.action.chat.open');
                } catch (e) {
                    // Ignore if chat open fails
                }
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Error preparing review: ${err}`);
        }
    });
}

function changeTypeString(ct: GitInterfaces.VersionControlChangeType | undefined): string {
    if (!ct) { return '[?]'; }
    if (ct & GitInterfaces.VersionControlChangeType.Add) { return '[ADD]'; }
    if (ct & GitInterfaces.VersionControlChangeType.Delete) { return '[DELETE]'; }
    if (ct & GitInterfaces.VersionControlChangeType.Rename) { return '[RENAME]'; }
    if (ct & GitInterfaces.VersionControlChangeType.Edit) { return '[EDIT]'; }
    return '[CHANGE]';
}
