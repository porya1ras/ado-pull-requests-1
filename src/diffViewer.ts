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
        const objectId = params.get('objectId')!;
        const orgUrl = params.get('orgUrl')!;

        console.log(`Fetching blob: repo=${repoId}, objectId=${objectId}, org=${orgUrl}`);

        if (!objectId || objectId === '0000000000000000000000000000000000000000') {
            return ''; 
        }

        try {
            const client = new AdoClient(orgUrl);
            const content = await client.getFileContent(repoId, objectId);
            this._cache.set(uri.toString(), content);
            return content;
        } catch (err) {
            console.error('Failed to fetch file content:', err);
            vscode.window.showErrorMessage(`Failed to fetch file content: ${err}`);
            return `// Error fetching content: ${err}`;
        }
    }
}

// ── Open Diff Command ────────────────────────────────────────────────

export async function openFileDiff(node: FileChangeNode): Promise<void> {
    const change = node.change as any;
    const filePath: string = change.item?.path ?? 'unknown';
    const objectId: string = change.item?.objectId ?? '';
    const originalObjectId: string = change.originalObjectId ?? change.item?.originalObjectId ?? '';

    console.log(`Opening diff for ${filePath}: left=${originalObjectId}, right=${objectId}`);

    const makeUri = (oid: string, side: string) =>
        vscode.Uri.parse(`${ADO_PR_SCHEME}:${filePath.startsWith('/') ? filePath : '/' + filePath}`)
            .with({
                query: `repoId=${node.repoId}&objectId=${oid}&orgUrl=${encodeURIComponent(node.orgUrl)}&side=${side}`,
            });

    const leftUri = makeUri(originalObjectId, 'left');
    const rightUri = makeUri(objectId, 'right');

    const title = `${filePath.split('/').pop() || filePath} (PR #${node.pr.pullRequestId})`;

    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
}
