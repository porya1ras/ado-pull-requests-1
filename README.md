<p align="center">
  <img src="https://img.icons8.com/fluency/96/pull-request.png" alt="ADO Pull Requests Logo" width="96" />
</p>

<h1 align="center">Azure DevOps Pull Requests</h1>

<p align="center">
  <strong>A modern, high-performance Webview sidebar to browse, review, and manage Azure DevOps Pull Requests — without leaving VS Code.</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#getting-started">Getting Started</a> •
  <a href="#usage">Usage</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#contributing">Contributing</a> •
  <a href="#license">License</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/VS%20Code-1.109.0+-blue?logo=visualstudiocode&logoColor=white" alt="VS Code 1.109.0+" />
  <img src="https://img.shields.io/badge/TypeScript-5.1-blue?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Azure%20DevOps-REST%20API-0078D4?logo=azuredevops&logoColor=white" alt="Azure DevOps" />
  <img src="https://img.shields.io/badge/UI-Modern%20Webview-FF4081?logo=web&logoColor=white" alt="Modern Webview UI" />
</p>

---

## ✨ Overview

**ADO Pull Requests** has been reimagined as a feature-rich **Webview Explorer**. It brings a professional, interactive interface to your VS Code sidebar, allowing you to instantly search repositories, filter PRs by source and target branches, and jump into detailed code reviews with AI assistance—all wrapped in a sleek, responsive design.

<p align="center">
  <!-- TODO: ADD IMAGE: Main Webview Explorer Overview -->
  <img src="https://raw.githubusercontent.com/porya1ras/ado-pull-requests-1/main/assets/webview-overview.png" alt="Webview Explorer Overview" width="700" />
  <br/><em>(New modern Webview-based sidebar with repository search and filters)</em>
</p>

---

## 🚀 Key Features

| Feature                           | Description                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 🌐 **Modern Webview UI**          | A completely custom, high-performance sidebar built with modern CSS, smooth transitions, and a premium "glassmorphism" aesthetic.                                                                                                                                                                                                                |
| 🔍 **Dynamic Repo Search**        | Quickly find and switch between any repository in your organization directly from the sidebar search box.                                                                                                                                                                                                                                       |
| 🎯 **Dual Branch Filtering**      | Filter PRs by **both** Source and Target branches using dedicated dropdowns for precise workflow management.                                                                                                                                                                                                                                    |
| 📄 **Nested PR Details**          | Click a PR to drill down into a detail view showing the description, author profile, and a complete file list without losing your context.                                                                                                                                                                                                       |
| 🤖 **AI Review Ecosystem**        | Direct access to **Copilot**, **DB Performance**, and **UX Message** reviews via quick-action buttons in the PR detail view.                                                                                                                                                                                                                      |
| 🔐 **Integrated Auth State**       | Visual feedback for your connection status (Signed in/out) with single-click authentication management in the sidebar and status bar.                                                                                                                                                                                                            |
| ⏳ **Polished Loading States**     | Professional "Activating..." overlays and spinners ensure you're always informed during data fetching and extension initialization.                                                                                                                                                                                                              |
| 🔀 **One-Click Diffing**          | Inspect changes instantly using VS Code's native side-by-side diff editor, triggered directly from the PR's file list.                                                                                                                                                                                                                           |

---

## 📦 Installation

### From source (development)

```bash
# Clone the repository
git clone https://github.com/porya1ras/ado-pull-requests-1.git
cd ado-pull-requests

# Install dependencies
npm install

# Compile and Bundle
npm run compile
```

### Running in VS Code

1. Open the project folder in VS Code.
2. Press **F5** (or **Run → Start Debugging**) to launch the **Extension Development Host**.
3. The **Azure DevOps** icon will appear in your Activity Bar.

---

## 🏁 Getting Started

### 1. Unified Authentication

You can sign in directly from the **Connect** button in the sidebar if you're not logged in, or use the **`ADO: Sign In`** command. The extension uses Microsoft SSO, so no Personal Access Tokens are needed.

<p align="center">
  <!-- TODO: ADD IMAGE: Sign-in State in Webview -->
  <img src="https://raw.githubusercontent.com/porya1ras/ado-pull-requests-1/main/assets/signin-state.png" alt="Sign-in State" width="350" />
  <br/><em>(Seamless connection management within the view)</em>
</p>

### 2. Search & Select Repository

Use the search box at the top of the explorer to find any repository across your projects. Selecting a repository will instantly populate the list with active Pull Requests.

### 3. Browse & Filter

Use the **Source Branch** and **Target Branch** filters to narrow down your view. The list updates in real-time as you select different branches.

---

## 📖 Usage

### Navigation Workflow

The explorer uses a breadcrumb-style navigation:
1. **List View**: Browse all PRs, search repos, and apply filters.
2. **Detail View**: Click a PR to see its full details, including author (with quick mailto link) and the list of changed files.
3. **Diff View**: Click any file in the detail view to open the VS Code diff editor.

<p align="center">
  <!-- TODO: ADD IMAGE: PR Detail View and File List -->
  <img src="https://raw.githubusercontent.com/porya1ras/ado-pull-requests-1/main/assets/detail-view.png" alt="PR Detail View" width="350" />
  <br/><em>(Detailed PR view with integrated file explorer and AI actions)</em>
</p>

### AI-Powered Code Reviews

From the PR Detail view, you can trigger specialized AI reviews:
* 💬 **Copilot** - Logic, security, and general code quality.
* 🗄️ **DB Perf** - Entity Framework optimizations and SQL performance.
* 📝 **UX Review** - Language clarity, UK spelling, and user experience analysis.

<p align="center">
  <!-- TODO: ADD IMAGE: AI Review Results and Checklist -->
  <img src="https://raw.githubusercontent.com/porya1ras/ado-pull-requests-1/main/assets/review-results.png" alt="AI Review Results Checklist" width="600" />
  <br/><em>(Interactive AI review results with severity-coded checklist and automated posting)</em>
</p>

---

## 🏗️ Architecture

```
src/
├── prWebviewProvider.ts  # Main sidebar Webview logic (React-like state management)
├── extension.ts          # Extension entry point & command registration
├── auth.ts               # Microsoft SSO & Session management
├── adoClient.ts          # Azure DevOps REST API wrapper
├── diffViewer.ts         # Logic to fetch and display file diffs
├── copilotReview.ts      # AI logic for General Reviews
├── dbPerformanceReview.ts# AI logic for Database optimizations
├── uxMessageReview.ts    # AI logic for UX/UI text reviews
└── reviewWebview.ts      # Interactive UI for AI review selection & posting
```

---

## ⚙️ Available Commands

| Command                      | ID                          | Description                                         |
| ---------------------------- | --------------------------- | --------------------------------------------------- |
| **ADO: Sign In**             | `adoPr.signIn`              | Authenticate with Microsoft / Azure AD              |
| **ADO: Select Repository**   | `adoPr.selectRepo`          | Dynamic repo selection dialog                       |
| **Sign Out**                 | `adoPr.signOut`             | Disconnect from Azure DevOps                        |
| **Refresh PR List**          | `adoPr.refresh`             | Manually reload data in the webview                 |
| **Send PR to AI Review**     | `adoPr.copilotReview`       | Trigger AI analysis via Copilot                     |
| **ADO: DB Perf Review** | `adoPr.dbPerformanceReview` | Trigger specialized database analysis               |
| **ADO: UX Review**     | `adoPr.uxMessageReview`     | Trigger specialized UX/Content analysis             |

---

## 🛠️ Development

```bash
npm run compile       # Build with webpack (development)
npm run watch         # Watch mode — rebuilds on file changes
npm run lint          # Run ESLint on src/
```

---

## 🤝 Contributing

1. **Fork** the repository
2. **Branch**: `git checkout -b feature/ui-improvement`
3. **Commit**: `git commit -m "Added glassmorphism to sidebar"`
4. **Push & PR**: Open a Pull Request for review

---

## 📝 License

This project is licensed under the **MIT License**.

<p align="center">
  Built for developers who demand a premium Azure DevOps experience in VS Code.
</p>
