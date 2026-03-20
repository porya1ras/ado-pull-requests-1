import * as vscode from 'vscode';
import * as GitInterfaces from 'azure-devops-node-api/interfaces/GitInterfaces';
import { AdoClient } from './adoClient';
import { PrNode } from './prTreeDataProvider';

export async function sendPrToDbPerformanceReview(node: PrNode): Promise<void> {
    const client = new AdoClient(node.orgUrl);

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Preparing PR for DB Performance review…',
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

            const promptTemplate = `You are an expert AI Pull Request reviewer specializing in .NET, EF Core, LINQ, and database performance.

Your task is to review the provided Pull Request and specifically verify that database queries use proper projection wherever appropriate.

Focus especially on:
- Queries that load full entities when only a subset of fields is needed
- Missing \`.Select(...)\` projections in read/query scenarios
- Returning full entity graphs to DTO/view model mappings after materialization instead of projecting in the query
- Over-fetching data from the database
- Unnecessary \`Include(...)\` usage when projection would be more efficient
- Queries that materialize data too early using \`ToList()\`, \`FirstOrDefault()\`, etc. before projection
- Cases where projection should be done at the database level rather than in memory
- Read-only queries that should use \`AsNoTracking()\` together with projection where appropriate
- Potential N+1 or performance issues related to poor query shaping

Review rules:
1. Prefer projection for read/query use cases.
2. If the code only needs a few fields, recommend projecting only those fields.
3. If a DTO/response model is being built after fetching full entities, flag it when it could be projected directly in the query.
4. Do not suggest projection when the full aggregate/entity is genuinely required for domain behavior, updates, or invariant enforcement.
5. Distinguish between command/update scenarios and query/read scenarios.
6. Consider maintainability and performance, not just syntax.
7. Be precise and actionable.

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
    "summary": "A short summary of the review and final verdict on query efficiency",
    "overallRisk": "low" | "medium" | "high",
    "confidence": 0.0-1.0
  },
  "checks": {
    "bugs": { "status": "pass"|"warn"|"fail", "note": null },
    "security": { "status": "pass"|"warn"|"fail", "note": null },
    "performance": { "status": "pass"|"warn"|"fail", "note": "Final Verdict on query efficiency" },
    "maintainability": { "status": "pass"|"warn"|"fail", "note": null },
    "tests": { "status": "pass"|"warn"|"fail", "note": null }
  },
  "comments": [
    {
      "id": "unique-id-string",
      "severity": "blocker"|"high"|"medium"|"low"|"nit",
      "category": "performance",
      "filePath": "path/to/file",
      "side": "RIGHT",
      "line": <number|null>,
      "startLine": <number|null>,
      "endLine": <number|null>,
      "title": "Title of the issue",
      "message": "Problem + Recommendation",
      "suggestion": "Suggested code improvement if possible",
      "rationale": "Why it matters"
    }
  ],
  "generalSuggestions": [
    { "title": "Example Suggestion", "message": "Example details" }
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
{{DIFF}}

Optional Context:
{{ADDITIONAL_CONTEXT}}`;

            const prompt = promptTemplate
                .replace('{{PR_TITLE}}', node.pr.title || '(none)')
                .replace('{{PR_DESCRIPTION}}', node.pr.description || '(none)')
                .replace('{{PR_ID}}', node.pr.pullRequestId?.toString() || '0')
                .replace('{{CHANGED_FILES}}', changedFiles.join('\n'))
                .replace('{{DIFF}}', diffParts.join('\n'))
                .replace('{{ADDITIONAL_CONTEXT}}', '');

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
