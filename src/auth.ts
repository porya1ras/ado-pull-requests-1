import * as vscode from 'vscode';
import * as azdev from 'azure-devops-node-api';

const ADO_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default'; // Azure DevOps scope

export class AuthManager {
    private static instance: AuthManager;
    private session: vscode.AuthenticationSession | undefined;
    private secretStorage: vscode.SecretStorage | undefined;
    private globalState: vscode.Memento | undefined;

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
        this.globalState = context.globalState;
    }

    clearCache() {
        this.cachedPat = undefined;
        this.cachedAccessToken = undefined;
        this.session = undefined;
    }

    async signOut(): Promise<void> {
        if (this.secretStorage) {
            await this.secretStorage.delete('ado_pat');
        }
        if (this.globalState) {
            await this.globalState.update('adoPr.isLoggedOut', true);
        }
        this.clearCache();
    }

    async getSession(createIfNone: boolean = false): Promise<vscode.AuthenticationSession | undefined> {
        if (this.session) {
            return this.session;
        }
        this.session = await vscode.authentication.getSession('microsoft', [ADO_SCOPE], { createIfNone });
        if (this.session) {
            this.cachedAccessToken = this.session.accessToken;
            if (this.globalState) {
                await this.globalState.update('adoPr.isLoggedOut', false);
            }
        }
        return this.session;
    }

    async getWebApi(): Promise<azdev.WebApi | undefined> {
        return undefined;
    }

    async storePat(pat: string): Promise<void> {
        if (this.secretStorage) {
            await this.secretStorage.store('ado_pat', pat);
            this.cachedPat = pat;
            this.cachedAccessToken = undefined;
            if (this.globalState) {
                await this.globalState.update('adoPr.isLoggedOut', false);
            }
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

        if (this.globalState?.get<boolean>('adoPr.isLoggedOut')) {
            return undefined;
        }

        // Find PAT first as an override
        const pat = await this.getPat();
        if (pat) {
            this.cachedAccessToken = pat;
            return pat;
        }

        try {
            const session = await this.getSession(false);
            this.cachedAccessToken = session?.accessToken;
            return this.cachedAccessToken;
        } catch (e) {
            console.error('Failed to get MS session:', e);
            return undefined;
        }
    }
}
