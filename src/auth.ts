import * as vscode from 'vscode';
import * as azdev from 'azure-devops-node-api';

const ADO_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default'; // Azure DevOps scope

export class AuthManager {
    private static instance: AuthManager;
    private session: vscode.AuthenticationSession | undefined;
    private secretStorage: vscode.SecretStorage | undefined;

    // Cache variables for session and tokens
    private cachedPat: string | null | undefined = undefined;
    private cachedAccessToken: string | undefined = undefined;

    private constructor() { }

    static getInstance(): AuthManager {
        if (!AuthManager.instance) {
            AuthManager.instance = new AuthManager();
        }
        return AuthManager.instance;
    }

    initialize(context: vscode.ExtensionContext) {
        this.secretStorage = context.secrets;
    }

    clearCache() {
        this.cachedPat = undefined;
        this.cachedAccessToken = undefined;
        this.session = undefined;
    }

    async getSession(createIfNone: boolean = false): Promise<vscode.AuthenticationSession | undefined> {
        if (this.session) {
            return this.session;
        }
        this.session = await vscode.authentication.getSession('microsoft', [ADO_SCOPE], { createIfNone });
        if (this.session) {
            this.cachedAccessToken = this.session.accessToken;
        }
        return this.session;
    }

    async getWebApi(): Promise<azdev.WebApi | undefined> {
        // Return undefined here for now, as we need the Org URL to create the connection.
        // We will simple return the session token for now.
        return undefined;
    }

    async storePat(pat: string): Promise<void> {
        if (this.secretStorage) {
            await this.secretStorage.store('ado_pat', pat);
            this.cachedPat = pat;
            this.cachedAccessToken = undefined;
        }
    }

    async getPat(): Promise<string | undefined> {
        if (this.cachedPat !== undefined) {
            return this.cachedPat === null ? undefined : this.cachedPat;
        }
        if (this.secretStorage) {
            const pat = await this.secretStorage.get('ado_pat');
            this.cachedPat = pat || null;
            return pat;
        }
        return undefined;
    }

    async getAccessToken(): Promise<string | undefined> {
        if (this.cachedAccessToken) {
            return this.cachedAccessToken;
        }

        // Find PAT first as an override
        const pat = await this.getPat();
        if (pat) {
            this.cachedAccessToken = pat;
            return pat;
        }

        try {
            const session = await this.getSession(true);
            this.cachedAccessToken = session?.accessToken;
            return this.cachedAccessToken;
        } catch (e) {
            console.error('Failed to get MS session:', e);
            return undefined;
        }
    }
}
