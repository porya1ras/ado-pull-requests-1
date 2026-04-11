import * as vscode from 'vscode';
import * as GitInterfaces from 'azure-devops-node-api/interfaces/GitInterfaces';
import { AdoClient } from './adoClient';
import { FileChangeNode } from './prTreeDataProvider';

/**
 * URI scheme used for virtual documents that hold ADO file content.
 * Format:  ado-pr:<filePath>?repoId=...&objectId=...&orgUrl=...
 */
export const ADO_PR_SCHEME = 'ado-pr';

// ── Content Provider ─────────────────────────────────────────────────

export class AdoPrContentProvider implements vscode.TextDocumentContentProvider {

    private _cache = new Map<string, string>();

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        console.log(`Providing content for: ${uri.toString()}`);
        const cached = this._cache.get(uri.toString());
        if (cached !== undefined) { return cached; }

        const params = new URLSearchParams(uri.query);
        const repoId = params.get('repoId')!;
        const objectId = params.get('objectId');
        const commitId = params.get('commitId');
        const path = params.get('path');
        const orgUrl = params.get('orgUrl')!;

        console.log(`Fetching blob: repo=${repoId}, objectId=${objectId}, commitId=${commitId}, path=${path}, org=${orgUrl}`);

        if ((!objectId || objectId === '0000000000000000000000000000000000000000') && !commitId) {
            return ''; 
        }

        try {
            const client = new AdoClient(orgUrl);
            let content = '';
            if (objectId && objectId !== '0000000000000000000000000000000000000000') {
               content = await client.getFileContent(repoId, objectId);
            } else if (commitId && path) {
               content = await client.getFileContentByVersion(repoId, path, commitId);
               // Azure DevOps API stream might return a JSON error payload instead of throwing an HTTP error for missing items
               if (content && content.startsWith('{') && content.includes('"typeKey":"GitItemNotFoundException"')) {
                   content = '';
               }
            }
            this._cache.set(uri.toString(), content);
            return content;
        } catch (err: any) {
            console.error('Failed to fetch file content:', err);
            if (err?.message && err.message.toLowerCase().includes('could not be found')) {
                // Return empty if the file doesn't exist in that commit (e.g., added file)
                return '';
            }
            vscode.window.showErrorMessage(`Failed to fetch file content: ${err}`);
            return `// Error fetching content: ${err}`;
        }
    }
}

// ── Open Diff Command ────────────────────────────────────────────────

export async function openFileDiff(node: FileChangeNode): Promise<void> {
    const change = node.change as any;
    const item = change.item || change.originalItem;
    const filePath: string = item?.path ?? 'unknown';
    const originalPath: string = change.originalPath ?? filePath;
    const objectId: string = change.item?.objectId ?? '';
    const originalObjectId: string = change.originalObjectId ?? change.originalItem?.objectId ?? item?.originalObjectId ?? '';
    const baseCommitId: string = change.baseCommitId ?? '';

    console.log(`Opening diff for ${filePath}: left=${originalObjectId}, right=${objectId}, baseCommit=${baseCommitId}`);

    const makeUri = (oid: string, side: string, targetPath: string, commitId: string) => {
        let qs = `repoId=${node.repoId}&orgUrl=${encodeURIComponent(node.orgUrl)}&side=${side}&path=${encodeURIComponent(targetPath)}`;
        if (oid) { qs += `&objectId=${oid}`; }
        if (commitId) { qs += `&commitId=${commitId}`; }
        return vscode.Uri.parse(`${ADO_PR_SCHEME}:${targetPath.startsWith('/') ? targetPath : '/' + targetPath}`).with({ query: qs });
    };

    const leftUri = makeUri(originalObjectId, 'left', originalPath, baseCommitId);
    const rightUri = makeUri(objectId, 'right', filePath, '');

    const title = `${filePath.split('/').pop() || filePath} (PR #${node.pr.pullRequestId})`;

    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
}
