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
        title: 'Preparing PR for Copilot review…',
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

                // Fetch content for edits so Copilot can see the code
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

            const prompt = [
                `Please review the following pull request changes.`,
                `**PR:** ${node.pr.title} (#${node.pr.pullRequestId})`,
                `**Author:** ${node.pr.createdBy?.displayName}`,
                `**Description:** ${node.pr.description || '(none)'}`,
                '',
                '---',
                '',
                ...diffParts,
                '',
                'Please provide a thorough code review: identify bugs, security issues, performance concerns, and suggest improvements.',
            ].join('\n');

            // 4. Try to open Copilot Chat with the prompt
            try {
                await vscode.commands.executeCommand(
                    'workbench.action.chat.open',
                    { query: prompt },
                );
            } catch {
                // Fallback: open as a read-only document so the user can copy→paste
                const doc = await vscode.workspace.openTextDocument({
                    content: prompt,
                    language: 'markdown',
                });
                await vscode.window.showTextDocument(doc);
                vscode.window.showInformationMessage(
                    'Copilot Chat is not available. The review prompt has been opened in a new tab — you can copy it into any AI chat.',
                );
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
