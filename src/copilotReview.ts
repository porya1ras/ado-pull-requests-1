import * as vscode from 'vscode';
import * as GitInterfaces from 'azure-devops-node-api/interfaces/GitInterfaces';
import { AdoClient } from './adoClient';
import { PrNode } from './prTreeDataProvider';

/**
 * Collect the diff for every changed file in the PR and send a
 * review prompt to Copilot Chat (or fall back to a new editor tab).
 */
export async function sendPrToCopilotReview(node: PrNode): Promise<void> {
    const client = new AdoClient(node.orgUrl);

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Preparing PR for AI review…',
        cancellable: false,
    }, async () => {
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
            for (const entry of changes.changeEntries) {
                const e = entry as any;
                const path: string = e.item?.path ?? 'unknown';
                const objectId: string = e.item?.objectId ?? '';
                const originalObjectId: string = e.originalObjectId ?? e.item?.originalObjectId ?? '';
                const changeType = changeTypeString(entry.changeType);

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

            // const prompt = [
            //     `Please review the following pull request changes.`,
            //     `**PR:** ${node.pr.title} (#${node.pr.pullRequestId})`,
            //     `**Author:** ${node.pr.createdBy?.displayName}`,
            //     `**Description:** ${node.pr.description || '(none)'}`,
            //     '',
            //     '---',
            //     '',
            //     ...diffParts,
            //     '',
            //     'Please provide a thorough code review: identify bugs, security issues, performance concerns, and suggest improvements.',
            // ].join('\n');
            const prompt = [
                `You are a senior code reviewer for a pull request.`,
                `Your task: produce a structured review that can be converted into PR comments.`,
                ``,
                `RULES (must follow):`,
                `1) Output MUST be valid JSON only. No markdown, no extra text.`,
                `2) Do NOT invent files, line numbers, functions, or context not present in the diff.`,
                `3) If information is missing, set fields to null and explain in "note".`,
                `4) Prefer actionable, minimal, high-signal feedback.`,
                `5) Use the provided severity levels exactly: "blocker" | "high" | "medium" | "low" | "nit".`,
                `6) All comments must map to a specific diff location when possible.`,
                ``,
                `PR CONTEXT:`,
                `- title: ${node.pr.title}`,
                `- id: ${node.pr.pullRequestId}`,
                `- author: ${node.pr.createdBy?.displayName ?? '(unknown)'}`,
                `- description: ${node.pr.description || '(none)'}`,
                ``,
                `OUTPUT SCHEMA (JSON):`,
                `{
    "meta": {
      "schemaVersion": "1.0",
      "prId": <number>,
      "summary": <string>,
      "overallRisk": "low" | "medium" | "high",
      "confidence": 0.0-1.0
    },
    "checks": {
      "bugs": { "status": "pass"|"warn"|"fail", "note": <string|null> },
      "security": { "status": "pass"|"warn"|"fail", "note": <string|null> },
      "performance": { "status": "pass"|"warn"|"fail", "note": <string|null> },
      "maintainability": { "status": "pass"|"warn"|"fail", "note": <string|null> },
      "tests": { "status": "pass"|"warn"|"fail", "note": <string|null> }
    },
    "comments": [
      {
        "id": <string>,
        "severity": "blocker"|"high"|"medium"|"low"|"nit",
        "category": "bug"|"security"|"performance"|"style"|"maintainability"|"testing"|"docs",
        "filePath": <string>,
        "side": "RIGHT"|"LEFT",
        "line": <number|null>,
        "startLine": <number|null>,
        "endLine": <number|null>,
        "title": <string>,
        "message": <string>,
        "suggestion": <string|null>,
        "rationale": <string|null>
      }
    ],
    "generalSuggestions": [
      { "title": <string>, "message": <string> }
    ]
  }`,
                ``,
                `DIFF (unified). Use ONLY this content as ground truth:`,
                `---`,
                ...diffParts,
            ].join('\n');

            // 4. Try to open Copilot Chat with the prompt
            try {
                await vscode.commands.executeCommand(
                    'workbench.action.chat.open',
                    { query: prompt },
                );
            } catch {
                await vscode.env.clipboard.writeText(prompt);

                try {
                    // Try to open Cursor AI Chat
                    await vscode.commands.executeCommand('aichat.newchataction');

                    // Wait a moment for the chat input to focus, then paste
                    setTimeout(async () => {
                        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
                    }, 300);

                    vscode.window.showInformationMessage(
                        'Review prompt sent to Cursor Chat. If it didn\'t paste automatically, just press Ctrl+V or Cmd+V.',
                    );
                } catch {
                    try {
                        // Try to open Antigravity AI Chat
                        await vscode.commands.executeCommand('antigravity.toggleChatFocus');

                        setTimeout(async () => {
                            await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
                        }, 300);

                        vscode.window.showInformationMessage(
                            'Review prompt sent to AI Antigravity Chat. If it didn\'t paste automatically, just press Ctrl+V or Cmd+V.',
                        );
                    } catch {
                        // Fallback: open as a read-only document
                        const doc = await vscode.workspace.openTextDocument({
                            content: prompt,
                            language: 'markdown',
                        });
                        await vscode.window.showTextDocument(doc);
                        vscode.window.showInformationMessage(
                            'The review prompt has been copied to your clipboard. You can paste it into Cursor Chat or any AI chat.',
                        );
                    }
                }
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Error preparing review: ${err}`);
        }
    });
}

// ── helpers ──────────────────────────────────────────────────────────

function changeTypeString(ct: GitInterfaces.VersionControlChangeType | undefined): string {
    if (!ct) { return '[?]'; }
    if (ct & GitInterfaces.VersionControlChangeType.Add) { return '[ADD]'; }
    if (ct & GitInterfaces.VersionControlChangeType.Delete) { return '[DELETE]'; }
    if (ct & GitInterfaces.VersionControlChangeType.Rename) { return '[RENAME]'; }
    if (ct & GitInterfaces.VersionControlChangeType.Edit) { return '[EDIT]'; }
    return '[CHANGE]';
}
