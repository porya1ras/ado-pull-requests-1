import * as vscode from 'vscode';
import * as azdev from 'azure-devops-node-api';

const ADO_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default'; // Azure DevOps scope

export class AuthManager {
    private static instance: AuthManager;
    private session: vscode.AuthenticationSession | undefined;

    private constructor() { }

    static getInstance(): AuthManager {
        if (!AuthManager.instance) {
            AuthManager.instance = new AuthManager();
        }
        return AuthManager.instance;
    }

    async getSession(createIfNone: boolean = false): Promise<vscode.AuthenticationSession | undefined> {
        this.session = await vscode.authentication.getSession('microsoft', [ADO_SCOPE], { createIfNone });
        return this.session;
    }

    async getWebApi(): Promise<azdev.WebApi | undefined> {
        const session = await this.getSession(true);
        if (!session) {
            return undefined;
        }

        const authHandler = azdev.getBearerHandler(session.accessToken);
        // We need the org URL. For now, we'll ask the user or store it. 
        // But to just get the initial connection object, we can't fully initialize WebApi without a URL.
        // However, we can return the auth handler or just the token to be used later.
        // ACTUALLY: azdev.WebApi needs a URL. 
        // So we probably need to handle Org selection BEFORE fully creating the WebApi instance for specific calls.

        // Return undefined here for now, as we need the Org URL to create the connection.
        // We will simple return the session token for now.
        return undefined;
    }

    async getAccessToken(): Promise<string | undefined> {
        const session = await this.getSession(true);
        return session?.accessToken;
    }
}
