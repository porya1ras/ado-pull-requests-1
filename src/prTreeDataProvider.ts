import * as vscode from 'vscode';
import * as GitInterfaces from 'azure-devops-node-api/interfaces/GitInterfaces';
import { AdoClient } from './adoClient';

// ── Tree node types ──────────────────────────────────────────────────

export interface PrNode {
    kind: 'pr';
    pr: GitInterfaces.GitPullRequest;
    repoId: string;
    orgUrl: string;
}

export interface FileChangeNode {
    kind: 'file';
    change: GitInterfaces.GitPullRequestChange;
    pr: GitInterfaces.GitPullRequest;
    repoId: string;
    orgUrl: string;
}

export type PrTreeNode = PrNode | FileChangeNode;

// ── Change-type helpers ──────────────────────────────────────────────

function changeTypeLabel(ct: GitInterfaces.VersionControlChangeType | undefined): string {
    if (!ct) { return ''; }
    // The enum is a bitmask; check common flags
    if (ct & GitInterfaces.VersionControlChangeType.Add) { return 'A'; }
    if (ct & GitInterfaces.VersionControlChangeType.Delete) { return 'D'; }
    if (ct & GitInterfaces.VersionControlChangeType.Rename) { return 'R'; }
    if (ct & GitInterfaces.VersionControlChangeType.Edit) { return 'M'; }
    return '';
}

function changeTypeIcon(ct: GitInterfaces.VersionControlChangeType | undefined): vscode.ThemeIcon {
    if (!ct) { return new vscode.ThemeIcon('file'); }
    if (ct & GitInterfaces.VersionControlChangeType.Add) { return new vscode.ThemeIcon('diff-added'); }
    if (ct & GitInterfaces.VersionControlChangeType.Delete) { return new vscode.ThemeIcon('diff-removed'); }
    if (ct & GitInterfaces.VersionControlChangeType.Rename) { return new vscode.ThemeIcon('diff-renamed'); }
    if (ct & GitInterfaces.VersionControlChangeType.Edit) { return new vscode.ThemeIcon('diff-modified'); }
    return new vscode.ThemeIcon('file');
}

// ── Provider ─────────────────────────────────────────────────────────

export class PrTreeDataProvider implements vscode.TreeDataProvider<PrTreeNode> {

    private _onDidChange = new vscode.EventEmitter<PrTreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    private _prNodesCache: PrNode[] | undefined;
    private _changedFilesCache = new Map<number, FileChangeNode[]>();

    constructor(private context: vscode.ExtensionContext) { }

    refresh(): void {
        this._prNodesCache = undefined;
        this._changedFilesCache.clear();
        this._onDidChange.fire();
    }

    // --- TreeDataProvider interface ---

    getTreeItem(element: PrTreeNode): vscode.TreeItem {
        if (element.kind === 'pr') {
            return this.prTreeItem(element);
        }
        return this.fileTreeItem(element);
    }

    async getChildren(element?: PrTreeNode): Promise<PrTreeNode[]> {
        if (!element) {
            return this.getRootNodes();
        }
        if (element.kind === 'pr') {
            return this.getChangedFiles(element);
        }
        return []; // files have no children
    }

    // --- root: list PRs ---

    private async getRootNodes(): Promise<PrNode[]> {
        if (this._prNodesCache) {
            return this._prNodesCache;
        }

        const sel = this.context.workspaceState.get<{
            orgUrl: string; projectId: string; repoId: string; name: string;
        }>('adoPlugin.selectedRepo');

        if (!sel) {
            vscode.window.setStatusBarMessage('No repository selected – run "ADO: Select Repository"', 5000);
            return [];
        }

        try {
            const client = new AdoClient(sel.orgUrl);
            const prs = await client.getPullRequests(sel.repoId);
            this._prNodesCache = prs.map(pr => ({
                kind: 'pr' as const,
                pr,
                repoId: sel.repoId,
                orgUrl: sel.orgUrl,
            }));
            return this._prNodesCache;
        } catch (err) {
            vscode.window.showErrorMessage(`Error fetching PRs: ${err}`);
            return [];
        }
    }

    // --- children: changed files ---

    private async getChangedFiles(node: PrNode): Promise<FileChangeNode[]> {
        const prId = node.pr.pullRequestId!;
        if (this._changedFilesCache.has(prId)) {
            return this._changedFilesCache.get(prId)!;
        }

        try {
            const client = new AdoClient(node.orgUrl);
            const iterations = await client.getPullRequestIterations(node.repoId, prId);

            if (!iterations.length) { return []; }

            const latestIteration = iterations[iterations.length - 1];
            const changes = await client.getPullRequestIterationChanges(
                node.repoId,
                prId,
                latestIteration.id!,
            );

            if (!changes.changeEntries) { return []; }

            const result = changes.changeEntries.map(c => ({
                kind: 'file' as const,
                change: c as GitInterfaces.GitPullRequestChange,
                pr: node.pr,
                repoId: node.repoId,
                orgUrl: node.orgUrl,
            }));
            this._changedFilesCache.set(prId, result);
            return result;
        } catch (err) {
            vscode.window.showErrorMessage(`Error fetching changed files: ${err}`);
            return [];
        }
    }

    // --- tree item builders ---

    private prTreeItem(node: PrNode): vscode.TreeItem {
        const item = new vscode.TreeItem(
            node.pr.title || 'Untitled PR',
            vscode.TreeItemCollapsibleState.Collapsed,
        );

        // Strip "refs/heads/" prefix for cleaner branch names
        const stripRef = (ref?: string) => ref?.replace(/^refs\/heads\//, '') || '?';
        const sourceBranch = stripRef(node.pr.sourceRefName);
        const targetBranch = stripRef(node.pr.targetRefName);

        item.description = `#${node.pr.pullRequestId}  ${sourceBranch} → ${targetBranch}`;
        item.tooltip = [
            node.pr.title || '',
            `${sourceBranch} → ${targetBranch}`,
            `by ${node.pr.createdBy?.displayName || 'Unknown'}`,
            '',
            node.pr.description || '',
        ].join('\n');
        item.iconPath = new vscode.ThemeIcon('git-pull-request');
        item.contextValue = 'pullRequest';
        return item;
    }

    private fileTreeItem(node: FileChangeNode): vscode.TreeItem {
        const filePath = (node.change as any).item?.path as string | undefined;
        const label = filePath ? filePath.split('/').pop()! : 'unknown file';
        const ct = node.change.changeType;

        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description = `${changeTypeLabel(ct)}  ${filePath || ''}`;
        item.iconPath = changeTypeIcon(ct);
        item.contextValue = 'changedFile';

        // On click → open diff
        item.command = {
            command: 'adoPr.viewFileDiff',
            title: 'View Diff',
            arguments: [node],
        };

        return item;
    }
}
