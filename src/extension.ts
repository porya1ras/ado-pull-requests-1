import * as vscode from 'vscode';
import { AuthManager } from './auth';
import { AdoClient } from './adoClient';
import { PrTreeDataProvider, PrNode, FileChangeNode } from './prTreeDataProvider';
import { AdoPrContentProvider, ADO_PR_SCHEME, openFileDiff } from './diffViewer';
import { sendPrToCopilotReview } from './copilotReview';

export function activate(context: vscode.ExtensionContext) {
    console.log('Extension "ado-pull-requests" is now active!');

    // ── Auth ──────────────────────────────────────────────────────────
    const signInDisposable = vscode.commands.registerCommand('adoPr.signIn', async () => {
        try {
            const authManager = AuthManager.getInstance();
            const session = await authManager.getSession(true);
            if (session) {
                vscode.window.showInformationMessage(`Signed in as ${session.account.label}`);
            } else {
                vscode.window.showWarningMessage('Sign in failed or cancelled.');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Sign in error: ${error}`);
        }
    });

    // ── Select Repo ──────────────────────────────────────────────────
    const selectRepoDisposable = vscode.commands.registerCommand('adoPr.selectRepo', async () => {
        try {
            const authManager = AuthManager.getInstance();
            const session = await authManager.getSession();
            if (!session) {
                await vscode.commands.executeCommand('adoPr.signIn');
                if (!await authManager.getAccessToken()) { return; }
            }

            // 1. Organisation URL
            let orgUrl = context.globalState.get<string>('adoPlugin.orgUrl');
            if (!orgUrl) {
                orgUrl = await vscode.window.showInputBox({
                    prompt: 'Enter your Azure DevOps Organization URL',
                    placeHolder: 'https://dev.azure.com/myorg',
                    ignoreFocusOut: true,
                });
                if (!orgUrl) { return; }
                if (!orgUrl.startsWith('http')) {
                    orgUrl = `https://dev.azure.com/${orgUrl}`;
                }
                await context.globalState.update('adoPlugin.orgUrl', orgUrl);
            }

            const client = new AdoClient(orgUrl);

            // 2. Project
            const projects = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Fetching projects…',
            }, () => client.getProjects());

            const project = await vscode.window.showQuickPick(
                projects.map(p => ({ label: p.name!, description: p.description, id: p.id! })),
                { placeHolder: 'Select a Project' },
            );
            if (!project) { return; }

            // 3. Repo
            const repos = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Fetching repositories…',
            }, () => client.getRepos(project.id));

            const repo = await vscode.window.showQuickPick(
                repos.map(r => ({
                    label: r.name!,
                    description: r.remoteUrl,
                    repoId: r.id!,
                    projectId: project.id,
                })),
                { placeHolder: 'Select a Repository' },
            );
            if (!repo) { return; }

            // 4. Save & refresh
            await context.workspaceState.update('adoPlugin.selectedRepo', {
                orgUrl,
                projectId: repo.projectId,
                repoId: repo.repoId,
                name: repo.label,
            });
            vscode.window.showInformationMessage(`Selected repository: ${repo.label}`);
            vscode.commands.executeCommand('adoPr.refresh');
        } catch (error) {
            vscode.window.showErrorMessage(
                `Error selecting repo: ${error instanceof Error ? error.message : error}`,
            );
        }
    });

    // ── Tree Provider ────────────────────────────────────────────────
    const prProvider = new PrTreeDataProvider(context);
    vscode.window.registerTreeDataProvider('ado-pr-explorer', prProvider);

    const refreshDisposable = vscode.commands.registerCommand('adoPr.refresh', () => {
        prProvider.refresh();
    });

    // ── Diff Content Provider ────────────────────────────────────────
    const contentProvider = new AdoPrContentProvider();
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(ADO_PR_SCHEME, contentProvider),
    );

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

    // ── Copilot Review ───────────────────────────────────────────────
    const copilotReviewDisposable = vscode.commands.registerCommand(
        'adoPr.copilotReview',
        async (node: PrNode) => {
            await sendPrToCopilotReview(node);
        },
    );

    // ── Subscriptions ────────────────────────────────────────────────
    context.subscriptions.push(
        signInDisposable,
        selectRepoDisposable,
        refreshDisposable,
        viewFileDiffDisposable,
        openPrDisposable,
        copilotReviewDisposable,
    );
}

export function deactivate() { }
