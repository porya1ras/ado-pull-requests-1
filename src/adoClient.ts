import * as azdev from 'azure-devops-node-api';
import * as CoreApi from 'azure-devops-node-api/CoreApi';
import * as GitApi from 'azure-devops-node-api/GitApi';
import * as CoreInterfaces from 'azure-devops-node-api/interfaces/CoreInterfaces';
import * as GitInterfaces from 'azure-devops-node-api/interfaces/GitInterfaces';
import { AuthManager } from './auth';

export class AdoClient {
    private connection: azdev.WebApi | undefined;

    constructor(private orgUrl: string) { }

    private async getConnection(): Promise<azdev.WebApi> {
        if (!this.connection) {
            const authManager = AuthManager.getInstance();
            const token = await authManager.getAccessToken();
            if (!token) {
                throw new Error("Not signed in");
            }

            // Heuristic: PATs are usually 52 chars base64, short. Bearer tokens (JWT) are hundreds of chars.
            let authHandler;
            if (token.length < 100) {
                authHandler = azdev.getPersonalAccessTokenHandler(token);
            } else {
                authHandler = azdev.getBearerHandler(token);
            }

            this.connection = new azdev.WebApi(this.orgUrl, authHandler);
        }
        return this.connection;
    }

    async getCoreApi(): Promise<CoreApi.ICoreApi> {
        const connection = await this.getConnection();
        return await connection.getCoreApi();
    }

    async getGitApi(): Promise<GitApi.IGitApi> {
        const connection = await this.getConnection();
        return await connection.getGitApi();
    }

    async getProjects(): Promise<CoreInterfaces.TeamProjectReference[]> {
        const coreApi = await this.getCoreApi();
        return await coreApi.getProjects();
    }

    async getRepos(projectId: string): Promise<GitInterfaces.GitRepository[]> {
        const gitApi = await this.getGitApi();
        return await gitApi.getRepositories(projectId);
    }

    async getPullRequests(repoId: string): Promise<GitInterfaces.GitPullRequest[]> {
        const gitApi = await this.getGitApi();
        const searchCriteria: GitInterfaces.GitPullRequestSearchCriteria = {
            status: GitInterfaces.PullRequestStatus.Active
        };
        return await gitApi.getPullRequests(repoId, searchCriteria);
    }

    async getPullRequestIterations(repoId: string, pullRequestId: number): Promise<GitInterfaces.GitPullRequestIteration[]> {
        const gitApi = await this.getGitApi();
        return await gitApi.getPullRequestIterations(repoId, pullRequestId);
    }

    async getPullRequestIterationChanges(
        repoId: string,
        pullRequestId: number,
        iterationId: number
    ): Promise<GitInterfaces.GitPullRequestIterationChanges> {
        const gitApi = await this.getGitApi();
        return await gitApi.getPullRequestIterationChanges(repoId, pullRequestId, iterationId);
    }

    async getFileContent(repoId: string, objectId: string): Promise<string> {
        const gitApi = await this.getGitApi();
        const stream = await gitApi.getBlobContent(repoId, objectId);
        return await this.streamToString(stream);
    }

    private streamToString(stream: NodeJS.ReadableStream): Promise<string> {
        return new Promise((resolve, reject) => {
            const chunks: Uint8Array[] = [];
            stream.on('data', (chunk: Uint8Array) => chunks.push(chunk));
            stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            stream.on('error', reject);
        });
    }

    async addPullRequestComment(repoId: string, pullRequestId: number, content: string): Promise<GitInterfaces.GitPullRequestCommentThread> {
        const gitApi = await this.getGitApi();
        const thread: GitInterfaces.GitPullRequestCommentThread = {
            comments: [
                {
                    content,
                    commentType: GitInterfaces.CommentType.Text
                }
            ],
            status: GitInterfaces.CommentThreadStatus.Active
        };
        return await gitApi.createThread(thread, repoId, pullRequestId);
    }

    /**
     * Create a comment thread on a PR with optional file-level positioning.
     * If `threadContext` is provided, the comment will appear inline on the
     * specified file/line range in the PR diff view.
     */
    async addPullRequestThreadComment(
        repoId: string,
        pullRequestId: number,
        content: string,
        threadContext?: GitInterfaces.CommentThreadContext,
        status?: GitInterfaces.CommentThreadStatus,
    ): Promise<GitInterfaces.GitPullRequestCommentThread> {
        const gitApi = await this.getGitApi();
        const thread: GitInterfaces.GitPullRequestCommentThread = {
            comments: [
                {
                    content,
                    commentType: GitInterfaces.CommentType.Text,
                },
            ],
            status: status ?? GitInterfaces.CommentThreadStatus.Active,
            threadContext,
        };
        return await gitApi.createThread(thread, repoId, pullRequestId);
    }
}
