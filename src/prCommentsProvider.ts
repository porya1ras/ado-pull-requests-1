import * as vscode from 'vscode';
import { ADO_PR_SCHEME } from './diffViewer';
import { AdoClient } from './adoClient';
import * as GitInterfaces from 'azure-devops-node-api/interfaces/GitInterfaces';

export class PrCommentsProvider implements vscode.CommentingRangeProvider {
    private commentController: vscode.CommentController;

    constructor(context: vscode.ExtensionContext) {
        this.commentController = vscode.comments.createCommentController('ado-pr-comments', 'ADO PR Comments');
        this.commentController.commentingRangeProvider = this;
        context.subscriptions.push(this.commentController);

        context.subscriptions.push(vscode.commands.registerCommand('adoPr.createComment', this.createComment.bind(this)));
    }

    provideCommentingRanges(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.Range[] {
        // Only provide comments for our virtual documents
        if (document.uri.scheme === ADO_PR_SCHEME) {
            return [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)];
        }
        return [];
    }

    private async createComment(reply: vscode.CommentReply) {
        const thread = reply.thread;
        const uri = thread.uri;
        
        // Parse uri query params
        const queryParams = new URLSearchParams(uri.query);
        const repoId = queryParams.get('repoId');
        const orgUrl = queryParams.get('orgUrl');
        const prIdStr = queryParams.get('prId');
        const path = queryParams.get('path');
        const side = queryParams.get('side'); // 'left' or 'right'
        
        if (!repoId || !prIdStr || !orgUrl || !path) {
            vscode.window.showErrorMessage('Missing required info to post a comment on this file.');
            return;
        }

        const prId = parseInt(prIdStr, 10);
        
        if (!thread.range) {
            vscode.window.showErrorMessage('Cannot post comment without a valid range.');
            return;
        }
        
        // ADO 1-indexed lines
        const line = thread.range.start.line + 1;
        
        // Show progress or busy state
        thread.canReply = false;
        thread.label = 'Posting comment...';

        try {
            const client = new AdoClient(orgUrl);
            const content = reply.text;
            
            const threadContext: GitInterfaces.CommentThreadContext = {
                filePath: path,
                rightFileStart: side === 'right' ? { line, offset: 1 } : undefined,
                rightFileEnd: side === 'right' ? { line, offset: 1 } : undefined,
                leftFileStart: side === 'left' ? { line, offset: 1 } : undefined,
                leftFileEnd: side === 'left' ? { line, offset: 1 } : undefined,
            };

            await client.addPullRequestThreadComment(repoId, prId, content, threadContext);

            // Create a VS Code comment to show it locally
            const newComment: vscode.Comment = {
                author: { name: 'You' }, // In a full implementation, we'd use the actual user profile
                body: new vscode.MarkdownString(content),
                mode: vscode.CommentMode.Preview,
            };

            thread.comments = [...thread.comments, newComment];

            vscode.window.showInformationMessage('Comment posted successfully');
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to post comment: ${error.message || error}`);
        } finally {
            thread.canReply = true;
            thread.label = undefined;
        }
    }
}
