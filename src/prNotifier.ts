import * as vscode from 'vscode';
import * as GitInterfaces from 'azure-devops-node-api/interfaces/GitInterfaces';
import { AdoClient } from './adoClient';

export class PrNotifier {
    private pollIntervalMs = 300000; // 5 minute
    private timer: NodeJS.Timeout | undefined;
    private cache = new Map<number, GitInterfaces.PullRequestStatus>();
    private isFirstRun = true;
    private currentRepoId: string | undefined;

    constructor(private context: vscode.ExtensionContext) {
        // Start polling
        this.startPolling();

        // Listen for workspace state changes if we can, 
        // but typically selected repo is updated via command, 
        // so we can just re-check the global state periodically.
    }

    private startPolling() {
        if (this.timer) {
            clearInterval(this.timer);
        }
        this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
        // Do an immediate poll 
        setTimeout(() => this.poll(), 5000); // delay start by 5s to avoid heavy load on activation
    }

    public stopPolling() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    private async poll() {
        try {
            const sel = this.context.workspaceState.get<{
                orgUrl: string; projectId: string; repoId: string; name: string;
            }>('adoPlugin.selectedRepo');

            if (!sel || !sel.repoId || !sel.orgUrl) {
                // No repo selected, nothing to poll
                return;
            }

            // If repo changed, reset cache
            if (this.currentRepoId !== sel.repoId) {
                this.currentRepoId = sel.repoId;
                this.cache.clear();
                this.isFirstRun = true;
            }

            const client = new AdoClient(sel.orgUrl);
            const activePrs = await client.getPullRequests(sel.repoId);
            const activeIds = new Set<number>();

            if (this.isFirstRun) {
                for (const pr of activePrs) {
                    if (pr.pullRequestId) {
                        this.cache.set(pr.pullRequestId, pr.status ?? GitInterfaces.PullRequestStatus.Active);
                    }
                }
                this.isFirstRun = false;
                return;
            }

            // Check for new PRs
            for (const pr of activePrs) {
                if (!pr.pullRequestId) continue;
                activeIds.add(pr.pullRequestId);

                const cachedStatus = this.cache.get(pr.pullRequestId);
                if (cachedStatus === undefined) {
                    // New PR
                    vscode.window.showInformationMessage(`New PR Created: #${pr.pullRequestId} - ${pr.title}`, 'View PR').then(selection => {
                        if (selection === 'View PR' && pr.repository?.webUrl) {
                            vscode.env.openExternal(vscode.Uri.parse(`${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}`));
                        }
                    });
                    this.cache.set(pr.pullRequestId, pr.status ?? GitInterfaces.PullRequestStatus.Active);
                    // Refresh the tree view automatically when a new PR is found
                    vscode.commands.executeCommand('adoPr.refresh');
                } else if (pr.status !== undefined && pr.status !== cachedStatus) {
                    // Status changed while still active (rare/impossible based on ADO logic, but just in case)
                    this.notifyStatusChange(pr);
                    this.cache.set(pr.pullRequestId, pr.status);
                    vscode.commands.executeCommand('adoPr.refresh');
                }
            }

            // Check for PRs that are no longer active
            const droppedIds: number[] = [];
            for (const [cachedId, cachedStatus] of this.cache.entries()) {
                if (!activeIds.has(cachedId)) {
                    droppedIds.push(cachedId);
                }
            }

            for (const id of droppedIds) {
                try {
                    const updatedPr = await client.getPullRequest(sel.repoId, id);
                    if (updatedPr && updatedPr.status !== undefined && updatedPr.status !== this.cache.get(id)) {
                        this.notifyStatusChange(updatedPr);
                    }
                } catch (err) {
                    console.error(`Failed to fetch dropped PR ${id}`, err);
                } finally {
                    // Remove from cache since it's no longer active. 
                    // We don't want to keep polling it or growing the cache forever.
                    this.cache.delete(id);
                }
                vscode.commands.executeCommand('adoPr.refresh');
            }

        } catch (error) {
            console.error('Error during PR polling:', error);
        }
    }

    private notifyStatusChange(pr: GitInterfaces.GitPullRequest) {
        const title = pr.title || 'Untitled';
        const statusName = this.getStatusName(pr.status);
        vscode.window.showInformationMessage(`PR #${pr.pullRequestId} status changed to ${statusName}: ${title}`, 'View PR').then(selection => {
            if (selection === 'View PR' && pr.repository?.webUrl) {
                vscode.env.openExternal(vscode.Uri.parse(`${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}`));
            }
        });
    }

    private getStatusName(status: GitInterfaces.PullRequestStatus | undefined): string {
        switch (status) {
            case GitInterfaces.PullRequestStatus.Active: return 'Active';
            case GitInterfaces.PullRequestStatus.Abandoned: return 'Abandoned';
            case GitInterfaces.PullRequestStatus.Completed: return 'Completed';
            default: return 'Unknown';
        }
    }
}
