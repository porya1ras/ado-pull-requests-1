import * as vscode from 'vscode';
import { AdoClient } from './adoClient';
import { PrNode } from './prTreeDataProvider';
import {
    ReviewPayload,
    buildSummaryComment,
    buildCommentBody,
    buildThreadContext,
    severityToThreadStatus
} from './postReviewComments';

export class ReviewWebviewPanel {
    public static currentPanel: ReviewWebviewPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private readonly _prNode: PrNode;
    private readonly _reviewPayload: ReviewPayload;

    public static createOrShow(prNode: PrNode, reviewPayload: ReviewPayload) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ReviewWebviewPanel.currentPanel) {
            ReviewWebviewPanel.currentPanel._panel.reveal(column);
            ReviewWebviewPanel.currentPanel.updateData(prNode, reviewPayload);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'adoPrReview',
            `AI Review: PR #${prNode.pr.pullRequestId}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        ReviewWebviewPanel.currentPanel = new ReviewWebviewPanel(panel, prNode, reviewPayload);
    }

    private constructor(panel: vscode.WebviewPanel, prNode: PrNode, reviewPayload: ReviewPayload) {
        this._panel = panel;
        this._prNode = prNode;
        this._reviewPayload = reviewPayload;

        this._update();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'postComments':
                        await this.handlePostComments(message.selectedCommentIds, message.postSummary);
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    public updateData(prNode: PrNode, reviewPayload: ReviewPayload) {
        // We aren't really mutating properties on update since it's a new PR usually,
        // but if we were:
        // this._prNode = prNode;
        // this._reviewPayload = reviewPayload;
        // this._update();
    }

    private async handlePostComments(selectedCommentIds: string[], postSummary: boolean) {
        const prId = this._prNode.pr.pullRequestId!;
        const client = new AdoClient(this._prNode.orgUrl);
        // Find matching comments based on ID or index fallback
        const selectedComments = this._reviewPayload.comments.filter(c => selectedCommentIds.includes(c.id));

        const action = await vscode.window.showInformationMessage(
            `You are about to post ${selectedComments.length} comments${postSummary ? ' plus a summary' : ''}. Proceed?`,
            { modal: true },
            'Post Comments'
        );

        if (action !== 'Post Comments') return;

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Posting selected AI review comments…',
                cancellable: false,
            },
            async (progress) => {
                let posted = 0;
                const totalToPost = selectedComments.length + (postSummary ? 1 : 0);
                if (totalToPost === 0) {
                    vscode.window.showInformationMessage('No comments selected to post.');
                    return;
                }

                try {
                    if (postSummary) {
                        progress.report({ message: 'Posting summary…', increment: 0 });
                        const summaryContent = buildSummaryComment(this._reviewPayload);
                        await client.addPullRequestComment(this._prNode.repoId, prId, summaryContent);
                        posted++;
                        progress.report({ increment: (1 / totalToPost) * 100 });
                    }

                    for (const comment of selectedComments) {
                        progress.report({ message: `Posting: ${comment.title}` });
                        const body = buildCommentBody(comment);
                        const threadContext = buildThreadContext(comment);

                        await client.addPullRequestThreadComment(
                            this._prNode.repoId,
                            prId,
                            body,
                            threadContext,
                            severityToThreadStatus(comment.severity),
                        );

                        posted++;
                        progress.report({ increment: (1 / totalToPost) * 100 });
                    }

                    vscode.window.showInformationMessage(`Successfully posted ${posted} comments to PR #${prId}`);
                    this.dispose(); // Close webview when done
                } catch (err) {
                    vscode.window.showErrorMessage(`Error posting comments: ${err}`);
                }
            }
        );
    }

    private _update() {
        this._panel.title = `Review: PR #${this._prNode.pr.pullRequestId}`;
        this._panel.webview.html = this._getHtmlForWebview();
    }

    private _getHtmlForWebview() {
        const severityIcons: Record<string, string> = {
            blocker: '🔴',
            high: '🟠',
            medium: '🟡',
            low: '🔵',
            nit: '⚪'
        };

        const riskIcons: Record<string, string> = {
            low: '🟢',
            medium: '🟡',
            high: '🔴'
        };

        // Modern VS Code styling using theme colors
        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>AI Review Results</title>
                <style>
                    body {
                        font-family: var(--vscode-font-family);
                        color: var(--vscode-editor-foreground);
                        background-color: var(--vscode-editor-background);
                        padding: 10px 20px 40px;
                        max-width: 1000px;
                        margin: 0 auto;
                    }
                    * { box-sizing: border-box; }
                    .header-container {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        position: sticky;
                        top: 0;
                        background: var(--vscode-editor-background);
                        padding: 20px 0;
                        border-bottom: 1px solid var(--vscode-panel-border);
                        z-index: 10;
                    }
                    button {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        padding: 10px 20px;
                        cursor: pointer;
                        border-radius: 4px;
                        font-weight: 600;
                        font-size: 14px;
                        transition: background 0.2s;
                    }
                    button:hover { background-color: var(--vscode-button-hoverBackground); }
                    .summary-box {
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 6px;
                        padding: 20px;
                        margin-bottom: 30px;
                        background-color: var(--vscode-editor-inactiveSelectionBackground);
                    }
                    .summary-title { margin-top: 0; display: flex; align-items: center; gap: 10px; }
                    .comment-item {
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 6px;
                        padding: 15px;
                        margin-bottom: 15px;
                        display: flex;
                        gap: 15px;
                        background-color: var(--vscode-textBlockQuote-background);
                        transition: border-color 0.2s;
                    }
                    .comment-item:hover { border-color: var(--vscode-focusBorder); }
                    .comment-content { flex: 1; }
                    .comment-content h3 { margin: 0 0 10px 0; font-size: 15px; }
                    .comment-meta {
                        font-size: 12px;
                        opacity: 0.8;
                        margin-bottom: 15px;
                        display: flex;
                        gap: 15px;
                    }
                    .badge {
                        padding: 2px 6px;
                        border-radius: 4px;
                        background: var(--vscode-badge-background);
                        color: var(--vscode-badge-foreground);
                        font-weight: bold;
                    }
                    .suggestion {
                        margin-top: 10px;
                        padding: 10px;
                        background: var(--vscode-editor-background);
                        border-left: 3px solid var(--vscode-textLink-foreground);
                        border-radius: 2px;
                        font-family: var(--vscode-editor-font-family);
                        font-size: 13px;
                        white-space: pre-wrap;
                    }
                    input[type=checkbox] {
                        width: 18px;
                        height: 18px;
                        cursor: pointer;
                        accent-color: var(--vscode-button-background);
                    }
                </style>
            </head>
            <body>
                <div class="header-container">
                    <h2>AI Review Results for PR #${this._prNode.pr.pullRequestId}</h2>
                    <button id="post-btn">Post Selected Comments</button>
                </div>

                <div class="summary-box">
                    <label class="summary-title">
                        <input type="checkbox" id="post-summary" checked />
                        <h3>Post Summary Comment</h3>
                    </label>
                    <div style="margin-left: 28px;">
                        <p><strong>Risk:</strong> <span class="badge">${riskIcons[this._reviewPayload.meta.overallRisk] || ''} ${this._reviewPayload.meta.overallRisk.toUpperCase()}</span> &nbsp; | &nbsp; <strong>Confidence:</strong> ${(this._reviewPayload.meta.confidence * 100).toFixed(0)}%</p>
                        <p style="white-space: pre-wrap;">${this._reviewPayload.meta.summary}</p>
                    </div>
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                    <h3>Thread Comments (${this._reviewPayload.comments.length})</h3>
                    <div>
                        <button id="sel-all" style="background:transparent; color:var(--vscode-textLink-foreground); font-weight:normal; padding:0;">Select All</button> |
                        <button id="sel-none" style="background:transparent; color:var(--vscode-textLink-foreground); font-weight:normal; padding:0;">Select None</button>
                    </div>
                </div>

                <div id="comments-container">
                    ${this._reviewPayload.comments.map((comment, i) => `
                        <label class="comment-item">
                            <input type="checkbox" class="comment-cb" value="${comment.id}" checked />
                            <div class="comment-content">
                                <h3>${severityIcons[comment.severity] || ''} [${comment.severity.toUpperCase()}] ${comment.title}</h3>
                                <div class="comment-meta">
                                    <span><strong>File:</strong> ${comment.filePath}</span>
                                    <span><strong>Line:</strong> ${comment.line || (comment.startLine ? comment.startLine + '-' + comment.endLine : 'N/A')}</span>
                                    <span><strong>Category:</strong> ${comment.category}</span>
                                </div>
                                <p style="white-space: pre-wrap;">${comment.message}</p>
                                ${comment.suggestion ? `<div class="suggestion">${comment.suggestion.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>` : ''}
                            </div>
                        </label>
                    `).join('')}
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    
                    document.getElementById('post-btn').addEventListener('click', () => {
                        const checkboxes = document.querySelectorAll('.comment-cb:checked');
                        const selectedCommentIds = Array.from(checkboxes).map(cb => cb.value);
                        const postSummary = document.getElementById('post-summary').checked;

                        vscode.postMessage({
                            command: 'postComments',
                            selectedCommentIds,
                            postSummary
                        });
                    });

                    document.getElementById('sel-all').addEventListener('click', () => {
                        document.querySelectorAll('.comment-cb').forEach(cb => cb.checked = true);
                    });
                    document.getElementById('sel-none').addEventListener('click', () => {
                        document.querySelectorAll('.comment-cb').forEach(cb => cb.checked = false);
                    });
                </script>
            </body>
            </html>`;
    }

    public dispose() {
        ReviewWebviewPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}
