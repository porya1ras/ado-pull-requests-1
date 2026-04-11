import * as vscode from 'vscode';
import { AdoClient } from './adoClient';
import { AuthManager } from './auth';
import { openFileDiff } from './diffViewer';

export class PrWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ado-pr-explorer';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'refresh':
          this.refresh();
          break;
        case 'fetchAllRepos':
          await this.handleFetchAllRepos();
          break;
        case 'setRepo':
          await this.handleSetRepo(data.repo);
          break;
        case 'openPr':
          await this.handlePrClick(data.prId, data.repoId, data.orgUrl);
          break;
        case 'openFileDiff':
          await this.handleOpenFileDiff(data);
          break;
        case 'aiReview':
          await this.handleAiReview(
            data.action,
            data.prId,
            data.repoId,
            data.orgUrl,
          );
          break;
        case 'signIn':
          await vscode.commands.executeCommand('adoPr.signIn');
          break;
        case 'signOut':
          await vscode.commands.executeCommand('adoPr.signOut');
          break;
        case 'openAuthorProfile':
          await this.handleOpenAuthorProfile(data.uniqueName, data.orgUrl);
          break;
      }
    });

    // Initial load
    this.updateState();

    // Refresh when view becomes visible
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.updateState();
      }
    });
  }

  public async refresh() {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'loading',
        value: true,
        text: 'Refreshing PRs and Repos...',
      });
      AuthManager.getInstance().clearCache();
      await this.updateState();
      this._view.webview.postMessage({ type: 'loading', value: false });
    }
  }

  private async handleFetchAllRepos() {
    if (!this._view) return;

    // Ensure we're signed in before trying to fetch
    const token = await AuthManager.getInstance().getAccessToken();
    if (!token) {
      this._view.webview.postMessage({ type: 'loggedOut' });
      return;
    }

    this._view.webview.postMessage({
      type: 'loading',
      value: true,
      text: 'Updating Repository List...',
    });

    try {
      const orgUrl = this._context.globalState.get<string>('adoPlugin.orgUrl');
      if (!orgUrl) return;

      const client = new AdoClient(orgUrl);
      const projects = await client.getProjects();

      const allReposPromise = projects.map((p) => client.getRepos(p.id!));
      const reposByProjectResults = await Promise.allSettled(allReposPromise);

      const flattenedRepos = reposByProjectResults
        .filter(
          (r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled',
        )
        .map((r) => r.value)
        .flat()
        .map((r) => ({
          id: r.id,
          name: r.name,
          project: r.project?.name,
          projectId: r.project?.id,
          url: r.remoteUrl,
          orgUrl,
        }));

      this._view.webview.postMessage({
        type: 'allRepos',
        repos: flattenedRepos,
      });
    } catch (err: any) {
      if (err?.message === 'Not signed in') {
        this._view.webview.postMessage({ type: 'loggedOut' });
      } else {
        vscode.window.showErrorMessage(`Error fetching repos: ${err}`);
      }
    } finally {
      this._view.webview.postMessage({ type: 'loading', value: false });
    }
  }

  private async handleSetRepo(repo: any) {
    await this._context.workspaceState.update('adoPlugin.selectedRepo', {
      orgUrl: repo.orgUrl,
      projectId: repo.projectId,
      repoId: repo.id,
      name: repo.name,
    });

    vscode.window.showInformationMessage(
      `Active repository set to: ${repo.name}`,
    );
    await this.updateState();
  }

  public async updateState() {
    if (!this._view) return;

    // Check auth first
    const token = await AuthManager.getInstance().getAccessToken();
    if (!token) {
      this._view.webview.postMessage({ type: 'loggedOut' });
      return;
    }

    const session = await AuthManager.getInstance().getSession();
    const userName = session?.account?.label || 'Connected';
    const userAvatar = (session as any)?.account?.avatarUrl;

    const sel = this._context.workspaceState.get<{
      orgUrl: string;
      projectId: string;
      repoId: string;
      name: string;
    }>('adoPlugin.selectedRepo');

    if (!sel) {
      const orgUrl = this._context.globalState.get<string>('adoPlugin.orgUrl');
      if (!orgUrl) {
        this._view.webview.postMessage({ type: 'loggedOut' });
        return;
      }
      this._view.webview.postMessage({ type: 'noRepo', value: true });
      await this.handleFetchAllRepos();
      return;
    }

    try {
      const client = new AdoClient(sel.orgUrl);
      const prs = await client.getPullRequests(sel.repoId);

      const sourceBranches = Array.from(
        new Set(
          prs.map(
            (pr) => pr.sourceRefName?.replace(/^refs\/heads\//, '') || '?',
          ),
        ),
      ).sort();
      const targetBranches = Array.from(
        new Set(
          prs.map(
            (pr) => pr.targetRefName?.replace(/^refs\/heads\//, '') || '?',
          ),
        ),
      ).sort();

      this._view.webview.postMessage({
        type: 'update',
        prs: prs.map((pr) => ({
          id: pr.pullRequestId,
          title: pr.title,
          source: pr.sourceRefName?.replace(/^refs\/heads\//, ''),
          target: pr.targetRefName?.replace(/^refs\/heads\//, ''),
          author: pr.createdBy?.displayName,
          authorAvatar: (pr.createdBy as any)?._links?.avatar?.href,
          authorUniqueName: pr.createdBy?.uniqueName,
          status: pr.status,
          repoId: sel.repoId,
          orgUrl: sel.orgUrl,
          description: pr.description,
        })),
        repoName: sel.name,
        sourceBranches,
        targetBranches,
        user: { name: userName, avatar: userAvatar },
      });

      this.handleFetchAllRepos();
    } catch (err: any) {
      this._view.webview.postMessage({ type: 'loading', value: false });
      if (err?.message === 'Not signed in') {
        this._view.webview.postMessage({ type: 'loggedOut' });
      } else {
        vscode.window.showErrorMessage(`Error updating webview: ${err}`);
        this._view.webview.postMessage({
          type: 'error',
          message:
            'Failed to load Pull Requests. Please check your connection and try again.',
        });
      }
    }
  }

  private async handlePrClick(prId: number, repoId: string, orgUrl: string) {
    if (!this._view) return;

    // Ensure we're signed in before trying to fetch
    const token = await AuthManager.getInstance().getAccessToken();
    if (!token) {
      this._view.webview.postMessage({ type: 'loggedOut' });
      return;
    }

    this._view.webview.postMessage({
      type: 'loading',
      value: true,
      text: 'Loading PR Details...',
    });

    try {
      const client = new AdoClient(orgUrl);
      const iterations = await client.getPullRequestIterations(repoId, prId);

      if (!iterations || !iterations.length) {
        vscode.window.showInformationMessage(
          `No iterations found for PR #${prId}.`,
        );
        return;
      }

      const latest = iterations[iterations.length - 1];
      const changes = await client.getPullRequestIterationChanges(
        repoId,
        prId,
        latest.id!,
      );

      const files = (changes.changeEntries || []).map((c) => {
        const item = c.item || (c as any).originalItem;
        return {
          path: item?.path,
          name: item?.path?.split('/').pop(),
          type: c.changeType,
          objectId: c.item?.objectId,
          originalObjectId:
            (c as any).originalObjectId || (c as any).originalItem?.objectId,
        };
      });

      this._view.webview.postMessage({
        type: 'showPrDetails',
        prId,
        files,
      });
    } catch (err: any) {
      if (err?.message === 'Not signed in') {
        this._view.webview.postMessage({ type: 'loggedOut' });
      } else {
        vscode.window.showErrorMessage(
          `Error fetching files: ${err.message || err}`,
        );
      }
    } finally {
      this._view.webview.postMessage({ type: 'loading', value: false });
    }
  }

  private async handleOpenFileDiff(data: any) {
    console.log(`Opening diff for: ${data.path}`);
    const node = {
      repoId: data.repoId,
      orgUrl: data.orgUrl,
      pr: { pullRequestId: data.prId } as any,
      change: {
        changeType: data.changeType,
        item: { path: data.path, objectId: data.objectId },
        originalObjectId: data.originalObjectId,
      } as any,
    };
    await openFileDiff(node as any);
  }

  private async handleAiReview(
    action: string,
    prId: number,
    repoId: string,
    orgUrl: string,
  ) {
    const node = {
      kind: 'pr',
      pr: { pullRequestId: prId } as any,
      repoId,
      orgUrl,
    };

    let commandId = '';
    switch (action) {
      case 'copilot':
        commandId = 'adoPr.copilotReview';
        break;
      case 'db':
        commandId = 'adoPr.dbPerformanceReview';
        break;
      case 'ux':
        commandId = 'adoPr.uxMessageReview';
        break;
    }

    if (commandId) {
      await vscode.commands.executeCommand(commandId, node);
    }
  }

  private async handleOpenAuthorProfile(uniqueName: string, orgUrl: string) {
    if (!uniqueName) return;
    vscode.env.openExternal(vscode.Uri.parse(`mailto:${uniqueName}`));
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    :root {
                        --padding: 12px;
                        --border-radius: 8px;
                        --card-bg: var(--vscode-sideBar-background);
                        --item-hover: var(--vscode-list-hoverBackground);
                        --item-active: var(--vscode-list-activeSelectionBackground);
                        --text-muted: var(--vscode-descriptionForeground);
                        --accent: var(--vscode-button-background);
                        --button-hover: var(--vscode-button-hoverBackground);
                        --error: var(--vscode-errorForeground);
                    }
                    body { padding: 0; margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background-color: var(--vscode-sideBar-background); font-size: var(--vscode-font-size); overflow: hidden; }
                    .page { display: flex; flex-direction: column; height: 100vh; width: 100%; position: absolute; top:0; left:0; transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); background-color: var(--vscode-sideBar-background); }
                    #list-page { transform: translateX(0); z-index: 10; }
                    #detail-page { transform: translateX(100%); z-index: 20; }
                    body.show-details #list-page { transform: translateX(-100%); }
                    body.show-details #detail-page { transform: translateX(0); }

                    .navbar { padding: 8px var(--padding); background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; min-height: 24px; }
                    .back-btn { background: transparent; border: none; color: var(--vscode-foreground); cursor: pointer; padding: 4px 8px; border-radius: 4px; display: flex; align-items: center; gap: 4px; font-size: 12px; }
                    .back-btn:hover { background: var(--item-hover); }

                    .filter-section { padding: var(--padding); display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
                    .filter-row { display: flex; flex-direction: column; gap: 4px; }
                    .filter-label { font-size: 10px; text-transform: uppercase; font-weight: 600; color: var(--text-muted); letter-spacing: 0.5px; }
                    select, input { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; padding: 6px; font-size: 12px; width: 100%; outline: none; box-sizing: border-box; }
                    select:hover, input:focus { border-color: var(--accent); }
                    
                    .pr-list { flex: 1; overflow-y: auto; padding: 8px; }
                    .pr-item { padding: 10px; border-radius: var(--border-radius); margin-bottom: 6px; cursor: pointer; background: var(--vscode-list-inactiveSelectionBackground); border: 1px solid transparent; transition: all 0.2s; }
                    .pr-item:hover { background: var(--item-hover); border-color: var(--vscode-focusBorder); }
                    .pr-header { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
                    .pr-meta { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-muted); }
                    
                    .branch-badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 1px 6px; border-radius: 10px; font-size: 10px; border: 1px solid transparent; }
                    .branch-badge.branch-red { background: rgba(255, 71, 71, 0.2); color: #ff4747; border-color: rgba(255, 71, 71, 0.3); }
                    .branch-badge.branch-blue { background: rgba(0, 122, 204, 0.2); color: #4fc1ff; border-color: rgba(0, 122, 204, 0.3); }
                    
                    /* Detail page styles */
                    .detail-header { padding: var(--padding); border-bottom: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; gap: 8px; }
                    .detail-title { font-size: 14px; font-weight: 600; line-height: 1.4; }
                    .detail-branches { display: flex; align-items: center; gap: 6px; }
                    .author-container { display: flex; align-items: center; gap: 6px; margin-top: 4px; cursor: pointer; }
                    .author-container:hover .author-name { text-decoration: underline; color: var(--accent); }
                    .author-avatar { width: 18px; height: 18px; border-radius: 50%; background: var(--item-hover); }
                    .author-name { font-size: 11px; color: var(--text-muted); }
                    
                    .review-actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 8px; }
                    .review-btn { background: var(--accent); color: var(--vscode-button-foreground); border: none; padding: 6px 4px; border-radius: 4px; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: 10px; font-weight: 500; transition: background 0.2s; }
                    .review-btn:hover { background: var(--button-hover); }
                    .review-btn svg { width: 14px; height: 14px; }

                    .file-list { flex: 1; overflow-y: auto; padding: 8px; }
                    .file-item { padding: 6px 10px; cursor: pointer; border-radius: 4px; display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
                    .file-item:hover { background: var(--item-hover); }
                    .file-icon { font-size: 10px; font-weight: bold; width: 14px; text-align: center; }
                    .file-icon.A { color: #4ec9b0; }
                    .file-icon.M { color: #ce9178; }
                    .file-icon.D { color: #f48771; }
                    .file-name { font-size: 12px; flex: 1; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; }

                    #loading-overlay { 
                        position: absolute; 
                        inset: 0; 
                        background: var(--vscode-sideBar-background); 
                        display: flex; 
                        flex-direction: column; 
                        justify-content: center; 
                        align-items: center; 
                        z-index: 1000; 
                        gap: 16px;
                        transition: opacity 0.3s ease;
                    }
                    .loading-content {
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        gap: 12px;
                        animation: fadeIn 0.5s ease-out;
                    }
                    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
                    .loading-text { 
                        font-size: 12px; 
                        color: var(--text-muted); 
                        font-weight: 500;
                        letter-spacing: 0.2px;
                    }
                    .spinner { 
                        width: 32px; 
                        height: 32px; 
                        border: 3px solid var(--vscode-widget-shadow); 
                        border-top-color: var(--accent); 
                        border-radius: 50%; 
                        animation: spin 1s cubic-bezier(0.4, 0, 0.2, 1) infinite; 
                    }
                    @keyframes spin { to { transform: rotate(360deg); } }

                    .combo-container { position: relative; }
                    .combo-list { position: absolute; top: 100%; left: 0; right: 0; background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); z-index: 50; max-height: 250px; overflow-y: auto; border-radius: 4px; display: none; box-shadow: 0 4px 12px rgba(0,0,0,0.4); }
                    .combo-item { padding: 8px 12px; cursor: pointer; font-size: 12px; border-bottom: 1px solid var(--vscode-panel-border); }
                    .combo-item:hover { background: var(--item-hover); }
                    .combo-item .proj { font-size: 10px; opacity: 0.6; display: block; margin-top: 2px; }

                    .status-bar { padding: 4px 12px; font-size: 10px; background: var(--vscode-statusBar-background); color: var(--vscode-statusBar-foreground); display: flex; align-items: center; gap: 6px; border-top: 1px solid var(--vscode-panel-border); }
                    .status-dot { width: 6px; height: 6px; border-radius: 50%; background: #4ec9b0; box-shadow: 0 0 4px #4ec9b0; }
                    .signout-link { margin-left: auto; color: inherit; cursor: pointer; opacity: 0.7; }
                    .signout-link:hover { opacity: 1; text-decoration: underline; }
                </style>
            </head>
            <body>
                <div id="list-page" class="page">
                    <div class="filter-section">
                        <div class="navbar" style="padding:0 0 8px 0; border:none;">
                            <span id="cur-repo">Pull Request Explorer</span>
                            <div style="flex:1"></div>
                            <button class="refresh-btn" id="refresh-btn" title="Refresh" style="background:transparent; border:none; color:inherit; cursor:pointer;"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4.681 3H2V2h3.5l.5.5V6H5V4.053a5.953 5.953 0 1 0 5.862-1.03l.337-.943A7 7 0 1 1 4.681 3z"/></svg></button>
                        </div>
                        <div class="filter-row">
                            <label class="filter-label">Repository</label>
                            <div class="combo-container">
                                <input type="text" id="repo-search" placeholder="Search Repos..." autocomplete="off">
                                <div id="repo-list" class="combo-list"></div>
                            </div>
                        </div>
                        <div class="filter-row">
                            <label class="filter-label">Source Branch</label>
                            <select id="src-filter"><option value="">All Source Branches</option></select>
                        </div>
                        <div class="filter-row">
                            <label class="filter-label">Target Branch</label>
                            <select id="tgt-filter"><option value="">All Target Branches</option></select>
                        </div>
                    </div>
                    <div class="pr-list" id="pr-list"></div>
                    <div class="status-bar" id="status-bar" style="display:none;">
                        <div class="status-dot"></div>
                        <span id="user-info">Signed in</span>
                        <a class="signout-link" onclick="vscode.postMessage({type:'signOut'})">Sign Out</a>
                    </div>
                </div>

                <div id="detail-page" class="page">
                    <div class="navbar">
                        <button class="back-btn" id="back-btn"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.67 3.87L9.9 2.1 3.5 8.5l6.4 6.4 1.77-1.77L6.03 8.5z"/></svg> Back</button>
                        <span id="detail-nav-id" style="opacity:0.6; font-weight:normal">PR Details</span>
                    </div>
                    <div class="detail-header" id="detail-header">
                        <div class="detail-title" id="det-title"></div>
                        <div class="detail-branches" id="det-branches"></div>
                        <div class="pr-meta" id="det-meta"></div>
                        
                        <div class="review-actions">
                            <button class="review-btn" onclick="aiReview('copilot')">
                                <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 0 8 8 8.009 8.009 0 0 0-8-8zm3.036 12.016a.434.434 0 0 1-.444.42.434.434 0 0 1-.444-.42 5.034 5.034 0 0 0-8.296-3.875.434.434 0 0 1-.611-.013.434.434 0 0 1 .013-.614 5.868 5.868 0 0 1 9.782 4.502z"/></svg>
                                Copilot
                            </button>
                            <button class="review-btn" onclick="aiReview('db')">
                                <svg viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 4v1.5c0 .828 2.462 1.5 5.5 1.5s5.5-.672 5.5-1.5V4c0-.828-2.462-1.5-5.5-1.5S2.5 3.172 2.5 4zm0 3.5v1.5c0 .828 2.462 1.5 5.5 1.5s5.5-.672 5.5-1.5V7.5c0 .828-2.462 1.5-5.5 1.5s-5.5-.672-5.5-1.5zm0 3.5V12c0 .828 2.462 1.5 5.5 1.5s5.5-.672 5.5-1.5v-1c0 .828-2.462 1.5-5.5 1.5s-5.5-.672-5.5-1.5z"/></svg>
                                DB Perf
                            </button>
                            <button class="review-btn" onclick="aiReview('ux')">
                                <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a6 6 0 1 0 6 6 6.007 6.007 0 0 0-6-6zm0 10a4 4 0 1 1 4-4 4.004 4.004 0 0 1-4 4zM7 7.5L8.5 6l2 3.5h-4L7 7.5z"/></svg>
                                UX Review
                            </button>
                        </div>
                    </div>
                    <div class="file-list" id="det-files"></div>
                </div>

                <div id="loading-overlay">
                    <div class="loading-content">
                        <div class="spinner"></div>
                        <div class="loading-text" id="loading-text">Activating Extension...</div>
                    </div>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    let allPrs = [], repos = [], currentPr = null;
                    const search = document.getElementById('repo-search'), list = document.getElementById('repo-list');

                    function showDetails(show) {
                        document.body.classList.toggle('show-details', show);
                    }

                    document.getElementById('back-btn').onclick = () => showDetails(false);

                    search.onfocus = () => { if(repos.length) list.style.display = 'block'; };
                    document.onclick = (e) => { if(!e.target.closest('.combo-container')) list.style.display = 'none'; };
                    search.oninput = (e) => renderRepos(e.target.value, true);

                    function renderRepos(val = '', show = false) {
                        list.innerHTML = '';
                        const filtered = repos.filter(r => r.name.toLowerCase().includes(val.toLowerCase()) || (r.project && r.project.toLowerCase().includes(val.toLowerCase())));
                        filtered.forEach(r => {
                            const d = document.createElement('div'); d.className = 'combo-item';
                            d.innerHTML = \`\${r.name}<span class="proj">\${r.project}</span>\`;
                            d.onclick = () => { 
                                vscode.postMessage({type:'setRepo', repo:r}); 
                                list.style.display='none'; 
                                search.value=r.name;
                                search.blur();
                            };
                            list.appendChild(d);
                        });
                        if (show) list.style.display = filtered.length ? 'block' : 'none';
                    }

                    function aiReview(action) {
                        if (!currentPr) return;
                        vscode.postMessage({
                            type: 'aiReview',
                            action,
                            prId: currentPr.id,
                            repoId: currentPr.repoId,
                            orgUrl: currentPr.orgUrl
                        });
                    }

                    function openAuthorProfile() {
                        if (!currentPr || !currentPr.authorUniqueName) return;
                        vscode.postMessage({
                            type: 'openAuthorProfile',
                            uniqueName: currentPr.authorUniqueName,
                            orgUrl: currentPr.orgUrl
                        });
                    }

                    window.onmessage = e => {
                        const m = e.data;
                        if(m.type==='update'){
                            document.getElementById('loading-overlay').style.display = 'none';
                            allPrs = m.prs; document.getElementById('cur-repo').textContent = m.repoName; search.value = m.repoName;
                            updateSel('src-filter', m.sourceBranches, 'All Source Branches');
                            updateSel('tgt-filter', m.targetBranches, 'All Target Branches');
                            if (m.user) {
                                document.getElementById('status-bar').style.display = 'flex';
                                document.getElementById('user-info').textContent = 'Signed in as ' + m.user.name;
                            }
                            filter();
                        } else if(m.type==='allRepos' || m.type==='noRepo') { 
                            if (m.repos) repos = m.repos; 
                            renderRepos(search.value, false); 
                            document.getElementById('loading-overlay').style.display = 'none';
                            if (m.type === 'noRepo') {
                                document.getElementById('pr-list').innerHTML = '<div style="padding:40px; text-align:center; opacity:0.5;">Please search and select a repository from the search box above.</div>';
                            }
                        } else if(m.type==='showPrDetails') {
                            renderPrDetails(m.prId, m.files);
                        } else if(m.type==='loggedOut') {
                            allPrs = []; repos = []; currentPr = null;
                            document.getElementById('pr-list').innerHTML = \`
                                <div style="padding:40px; text-align:center;">
                                    <div style="opacity:0.7; font-weight:500; margin-bottom:12px;">Connection closed.</div>
                                    <div style="font-size:11px; opacity:0.6; margin-bottom:24px;">Please sign in to view and manage Pull Requests.</div>
                                    <button class="review-btn" onclick="vscode.postMessage({type:'signIn'})" style="width:100%; flex-direction:row; justify-content:center; padding:10px; font-size:12px;">
                                        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="margin-right:8px;"><path d="M11 5H9V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2h-1zM3 13V3h5v2h2v1H8v1h2v1H8v1h2v2zm10.7-3.3l-2.4 2.4-1.4-1.4L11.6 9H8V7h3.6l-1.7-1.7 1.4-1.4 2.4 2.4a1 1 0 0 1 0 1.4z"/></svg>
                                        Sign In
                                    </button>
                                </div>
                            \`;
                            document.getElementById('cur-repo').textContent = 'Pull Request Explorer';
                            document.getElementById('status-bar').style.display = 'none';
                            search.value = '';
                            renderRepos('', false);
                            updateSel('src-filter', [], 'All Source Branches');
                            updateSel('tgt-filter', [], 'All Target Branches');
                            document.getElementById('loading-overlay').style.display = 'none';
                        } else if(m.type==='error') {
                            document.getElementById('loading-overlay').style.display = 'none';
                            document.getElementById('pr-list').innerHTML = \`
                                <div style="padding:40px; text-align:center;">
                                    <div style="color:var(--error); margin-bottom:12px;">⚠️ Error</div>
                                    <div style="font-size:11px; opacity:0.7;">\${m.message}</div>
                                    <button class="review-btn" onclick="vscode.postMessage({type:'refresh'})" style="margin-top:16px; width:100%;">Retry</button>
                                </div>
                            \`;
                        }
                        else if(m.type==='loading') {
                            document.getElementById('loading-overlay').style.display = m.value ? 'flex' : 'none';
                            if (m.text) {
                                document.getElementById('loading-text').textContent = m.text;
                            } else if (m.value) {
                                // Reset to default when showing without specific text
                                document.getElementById('loading-text').textContent = 'Connecting to Azure DevOps...';
                            }
                        }
                    };

                    function updateSel(id, items, def) {
                        const el = document.getElementById(id), cur = el.value;
                        el.innerHTML = \`<option value="">\${def}</option>\`;
                        items.forEach(i => { const o = document.createElement('option'); o.value=i; o.textContent=i; el.appendChild(o); });
                        el.value = cur;
                    }

                    function filter() {
                        const src = document.getElementById('src-filter').value, tgt = document.getElementById('tgt-filter').value;
                        renderPrs(allPrs.filter(p => (!src || p.source===src) && (!tgt || p.target===tgt)));
                    }

                    document.getElementById('src-filter').onchange = filter;
                    document.getElementById('tgt-filter').onchange = filter;
                    document.getElementById('refresh-btn').onclick = () => vscode.postMessage({type:'refresh'});

                    function getBranchClass(name) {
                        if (!name) return '';
                        const n = name.toLowerCase();
                        if (n === 'master' || n === 'main') return 'branch-red';
                        if (n === 'dev' || n === 'development') return 'branch-blue';
                        return '';
                    }

                    function renderPrs(prs) {
                        const l = document.getElementById('pr-list');
                        l.innerHTML = prs.length ? '' : '<div style="padding:40px; text-align:center; opacity:0.5;">No PRs found.</div>';
                        prs.forEach(p => {
                            const i = document.createElement('div'); i.className = 'pr-item';
                            i.innerHTML = \`<div class="pr-header">\${p.title}</div><div class="pr-meta"><span>#\${p.id}</span><span>\${p.author}</span></div><div class="pr-meta" style="margin-top:4px;"><span class="branch-badge \${getBranchClass(p.source)}">\${p.source}</span><span>→</span><span class="branch-badge \${getBranchClass(p.target)}">\${p.target}</span></div>\`;
                            i.onclick = () => {
                                currentPr = p;
                                vscode.postMessage({type:'openPr', prId:p.id, repoId:p.repoId, orgUrl:p.orgUrl});
                            };
                            l.appendChild(i);
                        });
                    }

                    function renderPrDetails(prId, files) {
                        const p = currentPr || allPrs.find(pr => pr.id === prId);
                        if (!p) return;

                        document.getElementById('detail-nav-id').textContent = \`PR #\${p.id}\`;
                        document.getElementById('det-title').textContent = p.title;
                        document.getElementById('det-branches').innerHTML = \`<span class="branch-badge \${getBranchClass(p.source)}">\${p.source}</span><span>→</span><span class="branch-badge \${getBranchClass(p.target)}">\${p.target}</span>\`;
                        document.getElementById('det-meta').innerHTML = \`
                            <div class="author-container" onclick="openAuthorProfile()" title="Send Email to Author">
                                <img class="author-avatar" src="\${p.authorAvatar || ''}" onerror="this.style.display='none'">
                                <span class="author-name">by \${p.author}</span>
                            </div>
                        \`;

                        const fl = document.getElementById('det-files');
                        fl.innerHTML = '';
                        files.forEach(f => {
                            const fi = document.createElement('div');
                            fi.className = 'file-item';
                            let char = 'M';
                            if (f.type & 1) char = 'A'; else if (f.type & 4) char = 'D'; else if (f.type & 8) char = 'R';
                            fi.innerHTML = \`<span class="file-icon \${char}">\${char}</span><span class="file-name" title="\${f.path}">\${f.name}</span>\`;
                            fi.onclick = () => {
                                vscode.postMessage({
                                    type: 'openFileDiff',
                                    prId, repoId: p.repoId, orgUrl: p.orgUrl,
                                    path: f.path, changeType: f.type, objectId: f.objectId, originalObjectId: f.originalObjectId
                                });
                            };
                            fl.appendChild(fi);
                        });

                        showDetails(true);
                    }
                </script>
            </body>
            </html>`;
  }
}
