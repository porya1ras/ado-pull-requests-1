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

            // 4. Send to background agent (vscode Language Model)
            try {
                progress.report({ message: 'Sending prompt to AI...', increment: 50 });

                const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
                if (!models || models.length === 0) {
                    vscode.window.showErrorMessage('GitHub Copilot chat model not found. Please install or sign in to GitHub Copilot.');
                    return;
                }
                const model = models[0];

                const messages = [
                    vscode.LanguageModelChatMessage.User(prompt)
                ];

                const chatResponse = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
                let responseText = '';
                for await (const fragment of chatResponse.text) {
                    responseText += fragment;
                }

                // Parse response
                progress.report({ message: 'Parsing AI response...', increment: 30 });
                const { extractReviewJson } = await import('./postReviewComments');
                const reviewPayload = extractReviewJson(responseText);

                // Show Webview
                const { ReviewWebviewPanel } = await import('./reviewWebview');
                ReviewWebviewPanel.createOrShow(node, reviewPayload);

            } catch (err) {
                vscode.window.showErrorMessage(`Error during AI review: ${err}`);
                // Optional Fallback to clipboard if they want
                await vscode.env.clipboard.writeText(prompt);
                vscode.window.showInformationMessage('Review prompt copied to clipboard due to failure.');
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
