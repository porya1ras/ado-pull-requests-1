import * as vscode from 'vscode';
import { AuthManager } from './auth';
import { AdoClient } from './adoClient';
import { PrNode, FileChangeNode } from './prTreeDataProvider';
import { PrWebviewProvider } from './prWebviewProvider';
import { AdoPrContentProvider, ADO_PR_SCHEME, openFileDiff } from './diffViewer';
import { sendPrToCopilotReview } from './copilotReview';
import { sendPrToDbPerformanceReview } from './dbPerformanceReview';
import { sendPrToUxMessageReview } from './uxMessageReview';
import { PrCommentsProvider } from './prCommentsProvider';


export function activate(context: vscode.ExtensionContext) {
    console.log('Extension "ado-pull-requests" is now active!');

    const authManager = AuthManager.getInstance();
    authManager.initialize(context);

    // ── Auth ──────────────────────────────────────────────────────────
    const signInActionDisposable = vscode.commands.registerCommand('adoPr.signInAction', async () => {
        try {
            const method = await vscode.window.showQuickPick(['Microsoft Authentication', 'Personal Access Token (PAT)'], {
                placeHolder: 'Select authentication method'
            });

            if (!method) { return; }

            if (method === 'Microsoft Authentication') {
                const session = await authManager.getSession(true);
                if (session) {
                    vscode.window.showInformationMessage(`Signed in as ${session.account.label}`);
                } else {
                    vscode.window.showWarningMessage('Sign in failed or cancelled.');
                }
            } else if (method === 'Personal Access Token (PAT)') {
                const pat = await vscode.window.showInputBox({
                    prompt: 'Enter your Azure DevOps PAT',
                    password: true
                });
                if (pat) {
                    await authManager.storePat(pat);
                    vscode.window.showInformationMessage('PAT saved successfully.');
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Sign in error: ${error}`);
        }
    });

    // ── Select Repo ──────────────────────────────────────────────────
    const selectRepoDisposable = vscode.commands.registerCommand('adoPr.selectRepo', async () => {
        prWebviewProvider.refresh();
        vscode.window.showInformationMessage("Repository selection is now available in the sidebar dropdown.");
    });

    // ── Connection Status ───────────────────────────────────────────
    const updateConnectionStatus = async (isConnecting: boolean = false) => {
        const token = await authManager.getAccessToken();
        const isConnected = !!token;
        vscode.commands.executeCommand('setContext', 'adoPr.isConnected', isConnected);
        vscode.commands.executeCommand('setContext', 'adoPr.isConnecting', isConnecting);
    };

    // ── Webview Provider ────────────────────────────────────────────
    const prWebviewProvider = new PrWebviewProvider(context.extensionUri, context);
    vscode.window.registerWebviewViewProvider(PrWebviewProvider.viewType, prWebviewProvider);

    // Initial load and status update
    (async () => {
        try {
            await updateConnectionStatus(true);
            await prWebviewProvider.updateState();
        } finally {
            await updateConnectionStatus(false);
        }
    })();

    const signOutDisposable = vscode.commands.registerCommand('adoPr.signOut', async () => {
        try {
            await updateConnectionStatus(true);
            await authManager.signOut();
            
            // Wipe configuration
            await context.globalState.update('adoPlugin.orgUrl', undefined);
            await context.workspaceState.update('adoPlugin.selectedRepo', undefined);
            
            await prWebviewProvider.updateState();
            vscode.window.showInformationMessage("Successfully signed out and cleared session data.");
        } finally {
            await updateConnectionStatus(false);
        }
    });

    const refreshLoadingDisposable = vscode.commands.registerCommand('adoPr.refreshLoading', () => {
        vscode.window.showInformationMessage("Connecting to Azure DevOps...");
    });

    const signInCommandDisposable = vscode.commands.registerCommand('adoPr.signIn', async () => {
        try {
            await updateConnectionStatus(true);
            await vscode.commands.executeCommand('adoPr.signInAction');
            authManager.clearCache();
            
            // Check if Org URL is missing (could happen after sign out)
            let orgUrl = context.globalState.get<string>('adoPlugin.orgUrl');
            if (!orgUrl) {
                orgUrl = await vscode.window.showInputBox({
                    prompt: 'Enter your Azure DevOps Organization URL (e.g., https://dev.azure.com/YourOrg)',
                    placeHolder: 'https://dev.azure.com/YourOrg',
                    ignoreFocusOut: true
                });
                if (orgUrl) {
                    await context.globalState.update('adoPlugin.orgUrl', orgUrl);
                    vscode.window.showInformationMessage(`Organization URL set to: ${orgUrl}`);
                }
            }

            if (orgUrl) {
                await prWebviewProvider.updateState();
            } else {
                vscode.window.showWarningMessage('Organization URL is required to load Pull Requests.');
            }
        } finally {
            await updateConnectionStatus(false);
        }
    });


    // ── Diff Content Provider ────────────────────────────────────────
    const contentProvider = new AdoPrContentProvider();
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(ADO_PR_SCHEME, contentProvider),
    );

    // ── Comments Provider ────────────────────────────────────────────
    new PrCommentsProvider(context);

    // ── View File Diff ───────────────────────────────────────────────
    const viewFileDiffDisposable = vscode.commands.registerCommand(
        'adoPr.viewFileDiff',
        async (node: FileChangeNode) => {
            await openFileDiff(node);
        },
    );

    // ── Open PR in Browser ───────────────────────────────────────────
    const openPrDisposable = vscode.commands.registerCommand(
        'adoPr.openPr',
        (node: PrNode) => {
            const pr = node.pr;
            if (pr?.repository?.webUrl && pr.pullRequestId) {
                const url = `${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}`;
                vscode.env.openExternal(vscode.Uri.parse(url));
            } else {
                vscode.window.showErrorMessage('Could not determine PR URL');
            }
        },
    );

    // ── AI Review Commands ───────────────────────────────────────────
    const copilotReviewDisposable = vscode.commands.registerCommand(
        'adoPr.copilotReview',
        async (node: PrNode) => {
            await sendPrToCopilotReview(node);
        },
    );

    const dbPerformanceReviewDisposable = vscode.commands.registerCommand(
        'adoPr.dbPerformanceReview',
        async (node: PrNode) => {
            await sendPrToDbPerformanceReview(node);
        },
    );

    const uxMessageReviewDisposable = vscode.commands.registerCommand(
        'adoPr.uxMessageReview',
        async (node: PrNode) => {
            await sendPrToUxMessageReview(node);
        },
    );

    // ── Subscriptions ────────────────────────────────────────────────
    context.subscriptions.push(
        signInActionDisposable,
        selectRepoDisposable,
        signOutDisposable,
        refreshLoadingDisposable,
        signInCommandDisposable,
        viewFileDiffDisposable,
        openPrDisposable,
        copilotReviewDisposable,
        dbPerformanceReviewDisposable,
        uxMessageReviewDisposable
    );
}

export function deactivate() { }
