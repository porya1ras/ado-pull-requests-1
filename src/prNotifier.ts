import * as vscode from 'vscode';
import * as http from 'http';
import localtunnel = require('localtunnel');
import { AdoClient } from './adoClient';

export class PrNotifier {
    private server: http.Server | undefined;
    private port = 34567; // Port to listen on
    private tunnel: localtunnel.Tunnel | undefined;
    private promptedRepos = new Set<string>();

    constructor(private context: vscode.ExtensionContext) {
        this.startServer();
        setTimeout(() => this.promptAndSetupWebhook(), 3000);
    }

    private startServer() {
        this.server = http.createServer((req, res) => {
            if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => {
                    body += chunk.toString();
                });
                req.on('end', () => {
                    try {
                        const payload = JSON.parse(body);
                        this.handleWebhookEvent(payload);
                    } catch (e) {
                        console.error('Failed to parse webhook payload', e);
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'success' }));
                });
            } else {
                res.writeHead(404);
                res.end();
            }
        });

        this.server.listen(this.port, () => {
            console.log(`ADO PR Webhook server listening on port ${this.port}`);
        });

        this.server.on('error', (e: any) => {
            if (e.code === 'EADDRINUSE') {
                console.error(`Failed to start ADO Hook server. Port ${this.port} is already in use.`);
            } else {
                console.error(`Webhook server error: ${e.message}`);
            }
        });
    }

    public async promptAndSetupWebhook() {
        const sel = this.context.workspaceState.get<{
            orgUrl: string; projectId: string; repoId: string; name: string;
        }>('adoPlugin.selectedRepo');

        if (!sel || !sel.projectId || !sel.orgUrl) {
            return;
        }

        if (this.promptedRepos.has(sel.projectId)) {
            return; // Already handled this session
        }
        this.promptedRepos.add(sel.projectId);

        const selection = await vscode.window.showInformationMessage(
            `Would you like to automatically configure an Azure DevOps Webhook for '${sel.name}' to get instant PR notifications?`,
            'Yes', 'No'
        );

        if (selection === 'Yes') {
            try {
                // Determine or start the localtunnel
                if (!this.tunnel) {
                    this.tunnel = await localtunnel({ port: this.port });
                    this.tunnel.on('close', () => {
                        this.tunnel = undefined;
                    });
                }
                const webhookUrl = `${this.tunnel.url}/webhook`;

                const client = new AdoClient(sel.orgUrl);

                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Creating Azure DevOps Webhook...',
                }, async () => {
                    // Try to clean up any old localtunnel hooks to avoid spamming ADO subscriptions
                    const existingHooks = await client.getServiceHooks(sel.projectId);
                    for (const hook of existingHooks) {
                        const url = hook.consumerInputs?.url;
                        if (url && url.includes('loca.lt') && hook.id) {
                            try {
                                const conn = await (client as any).getConnection();
                                await conn.rest.del(`${sel.orgUrl}/${sel.projectId}/_apis/hooks/subscriptions/${hook.id}?api-version=7.1-preview.1`);
                            } catch (e) { } // Ignore delete fail
                        }
                    }

                    // Create new hooks for created and updated
                    await client.createServiceHook(sel.projectId, 'git.pullrequest.created', webhookUrl);
                    await client.createServiceHook(sel.projectId, 'git.pullrequest.updated', webhookUrl);
                });

                vscode.window.showInformationMessage(`Successfully installed Webhook on Azure DevOps. (${webhookUrl})`);

            } catch (err) {
                vscode.window.showErrorMessage(`Failed to install Webhook: ${err}`);
            }
        }
    }

    public stopPolling() {
        if (this.server) {
            this.server.close();
            this.server = undefined;
        }
        if (this.tunnel) {
            this.tunnel.close();
            this.tunnel = undefined;
        }
    }

    private handleWebhookEvent(payload: any) {
        // We only care about git.pullrequest events
        const eventType = payload.eventType;
        if (!eventType || !eventType.startsWith('git.pullrequest')) {
            return;
        }

        const pr = payload.resource;
        if (!pr || !pr.pullRequestId) return;

        const sel = this.context.workspaceState.get<{
            orgUrl: string; projectId: string; repoId: string; name: string;
        }>('adoPlugin.selectedRepo');

        // Check if the webhook event is for the currently selected repository
        if (sel && sel.repoId && pr.repository && pr.repository.id !== sel.repoId) {
            return;
        }

        const prId = pr.pullRequestId;
        const title = pr.title || 'Untitled';

        let webUrl: string | undefined;
        if (sel) {
            webUrl = `${sel.orgUrl}/${sel.projectId}/_git/${sel.name}/pullrequest/${prId}`;
        }

        let message = '';
        if (eventType === 'git.pullrequest.created') {
            message = `New PR Created: #${prId} - ${title}`;
        } else if (eventType === 'git.pullrequest.updated') {
            const status = pr.status || 'updated';
            if (status.toLowerCase() !== 'active') {
                message = `PR #${prId} status changed to ${status}: ${title}`;
            } else {
                message = payload.message?.text || `PR #${prId} updated`;
            }
        } else {
            message = payload.message?.text || `PR #${prId} updated`;
        }

        vscode.window.showInformationMessage(message, 'View PR').then(selection => {
            if (selection === 'View PR' && webUrl) {
                vscode.env.openExternal(vscode.Uri.parse(webUrl));
            }
        });

        vscode.commands.executeCommand('adoPr.refresh');
    }
}
