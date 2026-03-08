#!/usr/bin/env node
"use strict";
/**
 * CLI tool for reviewing Azure DevOps Pull Requests with AI.
 *
 * Usage:
 *   npx ts-node cli/review-pr.ts \
 *     --org  https://dev.azure.com/myorg \
 *     --repo <repoId-or-name> \
 *     --pr   <pullRequestId> \
 *     --pat  <personalAccessToken> \
 *     --ai-key <openAI-api-key> \
 *     [--ai-model gpt-4o] \
 *     [--ai-base-url https://api.openai.com/v1] \
 *     [--project <projectId>] \
 *     [--output json|text|markdown] \
 *     [--out-file review-result.md]
 *
 * Environment variables (alternative to flags):
 *   ADO_PAT          – Azure DevOps Personal Access Token
 *   ADO_ORG          – Organisation URL
 *   OPENAI_API_KEY   – OpenAI (or compatible) API key
 *   OPENAI_BASE_URL  – Custom base URL (Azure OpenAI, Ollama, etc.)
 *   OPENAI_MODEL     – Model name (default: gpt-4o)
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const azdev = __importStar(require("azure-devops-node-api"));
const GitInterfaces = __importStar(require("azure-devops-node-api/interfaces/GitInterfaces"));
const https = __importStar(require("https"));
const http = __importStar(require("http"));
const fs = __importStar(require("fs"));
const url = __importStar(require("url"));
function parseArgs() {
    const args = process.argv.slice(2);
    const map = new Map();
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const key = args[i].replace(/^--/, '');
            const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
            map.set(key, val);
        }
    }
    const org = map.get('org') || process.env.ADO_ORG || '';
    const pat = map.get('pat') || process.env.ADO_PAT || '';
    const aiKey = map.get('ai-key') || process.env.OPENAI_API_KEY || '';
    const aiBaseUrl = map.get('ai-base-url') || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const aiModel = map.get('ai-model') || process.env.OPENAI_MODEL || 'gpt-4o';
    if (!org) {
        console.error('❌  --org (or ADO_ORG) is required');
        process.exit(1);
    }
    if (!pat) {
        console.error('❌  --pat (or ADO_PAT) is required');
        process.exit(1);
    }
    if (!aiKey) {
        console.error('❌  --ai-key (or OPENAI_API_KEY) is required');
        process.exit(1);
    }
    if (!map.get('pr')) {
        console.error('❌  --pr is required');
        process.exit(1);
    }
    if (!map.get('repo')) {
        console.error('❌  --repo is required');
        process.exit(1);
    }
    return {
        org,
        repo: map.get('repo'),
        pr: parseInt(map.get('pr'), 10),
        pat,
        project: map.get('project'),
        aiKey,
        aiModel,
        aiBaseUrl,
        output: map.get('output') || 'markdown',
        outFile: map.get('out-file'),
    };
}
// ────────────────────────────────────────────────────────────────────
// Azure DevOps helpers
// ────────────────────────────────────────────────────────────────────
async function getConnection(orgUrl, pat) {
    const handler = azdev.getPersonalAccessTokenHandler(pat);
    return new azdev.WebApi(orgUrl, handler);
}
function streamToString(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        stream.on('error', reject);
    });
}
function changeTypeString(ct) {
    if (!ct) {
        return '[?]';
    }
    if (ct & GitInterfaces.VersionControlChangeType.Add) {
        return '[ADD]';
    }
    if (ct & GitInterfaces.VersionControlChangeType.Delete) {
        return '[DELETE]';
    }
    if (ct & GitInterfaces.VersionControlChangeType.Rename) {
        return '[RENAME]';
    }
    if (ct & GitInterfaces.VersionControlChangeType.Edit) {
        return '[EDIT]';
    }
    return '[CHANGE]';
}
// ────────────────────────────────────────────────────────────────────
// Fetch PR diff
// ────────────────────────────────────────────────────────────────────
async function fetchPrDiff(conn, repoId, prId) {
    const gitApi = await conn.getGitApi();
    // PR info
    const pr = await gitApi.getPullRequestById(prId);
    console.log(`📌  PR #${pr.pullRequestId}: ${pr.title}`);
    console.log(`    Author : ${pr.createdBy?.displayName}`);
    console.log(`    Status : ${GitInterfaces.PullRequestStatus[pr.status]}`);
    console.log();
    // Iterations
    const iterations = await gitApi.getPullRequestIterations(repoId, prId);
    if (!iterations.length) {
        throw new Error('No iterations found for this PR');
    }
    const latestId = iterations[iterations.length - 1].id;
    // Changes
    const changes = await gitApi.getPullRequestIterationChanges(repoId, prId, latestId);
    if (!changes.changeEntries?.length) {
        throw new Error('No changed files in this PR');
    }
    const diffParts = [];
    for (const entry of changes.changeEntries) {
        const e = entry;
        const path = e.item?.path ?? 'unknown';
        const objectId = e.item?.objectId ?? '';
        const changeType = changeTypeString(entry.changeType);
        diffParts.push(`### ${changeType} ${path}`);
        if (entry.changeType !== undefined &&
            (entry.changeType & GitInterfaces.VersionControlChangeType.Delete) === 0 &&
            objectId) {
            try {
                const stream = await gitApi.getBlobContent(repoId, objectId);
                const content = await streamToString(stream);
                const trimmed = content.split('\n').slice(0, 200).join('\n');
                diffParts.push('```');
                diffParts.push(trimmed);
                diffParts.push('```');
            }
            catch {
                diffParts.push('_(content unavailable)_');
            }
        }
        diffParts.push('');
    }
    return { pr, diffParts };
}
// ────────────────────────────────────────────────────────────────────
// Build the review prompt (same as extension)
// ────────────────────────────────────────────────────────────────────
function buildPrompt(pr, diffParts) {
    return [
        `You are a senior code reviewer for a pull request.`,
        `Produce TWO outputs in this exact order:`,
        `A) A human-readable review (plain text).`,
        `B) A machine-readable JSON block for automated PR comments.`,
        ``,
        `STRICT RULES (must follow):`,
        `1) Use EXACTLY these section headers for part A:`,
        `   - SUMMARY`,
        `   - KEY RISKS`,
        `   - FILE-BY-FILE NOTES`,
        `   - TESTING RECOMMENDATIONS`,
        `   - FINAL VERDICT`,
        `2) Keep part A concise and high-signal. Max 250 lines.`,
        `3) After part A, output a single line delimiter EXACTLY as:`,
        `===JSON===`,
        `4) After the delimiter, output VALID JSON ONLY. No markdown, no extra text.`,
        `5) Do NOT invent files, line numbers, functions, or context not present in the diff.`,
        `6) If exact line numbers cannot be determined from the diff, set "line"/"startLine"/"endLine" to null and explain in "note" or "rationale".`,
        `7) Use the provided enums exactly:`,
        `   - severity: "blocker" | "high" | "medium" | "low" | "nit"`,
        `   - category: "bug" | "security" | "performance" | "style" | "maintainability" | "testing" | "docs"`,
        `   - side: "RIGHT" | "LEFT"`,
        `   - status: "pass" | "warn" | "fail"`,
        ``,
        `PR CONTEXT:`,
        `- title: ${pr.title}`,
        `- id: ${pr.pullRequestId}`,
        `- author: ${pr.createdBy?.displayName ?? '(unknown)'}`,
        `- description: ${pr.description || '(none)'}`,
        ``,
        `JSON SCHEMA (output must conform):`,
        `{`,
        `  "meta": {`,
        `    "schemaVersion": "1.0",`,
        `    "prId": <number>,`,
        `    "summary": <string>,`,
        `    "overallRisk": "low" | "medium" | "high",`,
        `    "confidence": 0.0-1.0`,
        `  },`,
        `  "checks": {`,
        `    "bugs":            { "status": "pass"|"warn"|"fail", "note": <string|null> },`,
        `    "security":        { "status": "pass"|"warn"|"fail", "note": <string|null> },`,
        `    "performance":     { "status": "pass"|"warn"|"fail", "note": <string|null> },`,
        `    "maintainability": { "status": "pass"|"warn"|"fail", "note": <string|null> },`,
        `    "tests":           { "status": "pass"|"warn"|"fail", "note": <string|null> }`,
        `  },`,
        `  "comments": [`,
        `    {`,
        `      "id": <string>,`,
        `      "severity": "blocker"|"high"|"medium"|"low"|"nit",`,
        `      "category": "bug"|"security"|"performance"|"style"|"maintainability"|"testing"|"docs",`,
        `      "filePath": <string>,`,
        `      "side": "RIGHT"|"LEFT",`,
        `      "line": <number|null>,`,
        `      "startLine": <number|null>,`,
        `      "endLine": <number|null>,`,
        `      "title": <string>,`,
        `      "message": <string>,`,
        `      "suggestion": <string|null>,`,
        `      "rationale": <string|null>`,
        `    }`,
        `  ],`,
        `  "generalSuggestions": [`,
        `    { "title": <string>, "message": <string> }`,
        `  ]`,
        `}`,
        ``,
        `DIFF (unified). Use ONLY this content as ground truth:`,
        `---`,
        ...diffParts,
    ].join('\n');
}
// ────────────────────────────────────────────────────────────────────
// Call OpenAI-compatible API
// ────────────────────────────────────────────────────────────────────
function callChatApi(baseUrl, apiKey, model, prompt) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
            max_tokens: 4096,
        });
        const parsed = new url.URL(`${baseUrl}/chat/completions`);
        const isHttps = parsed.protocol === 'https:';
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(body),
            },
        };
        const transport = isHttps ? https : http;
        const req = transport.request(options, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode && res.statusCode >= 400) {
                    return reject(new Error(`API ${res.statusCode}: ${raw}`));
                }
                try {
                    const json = JSON.parse(raw);
                    resolve(json.choices?.[0]?.message?.content ?? '');
                }
                catch {
                    reject(new Error(`Failed to parse API response: ${raw.slice(0, 500)}`));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
// ────────────────────────────────────────────────────────────────────
// Post review back to PR as comments (optional)
// ────────────────────────────────────────────────────────────────────
async function postReviewToPr(conn, repoId, prId, reviewText) {
    const gitApi = await conn.getGitApi();
    const thread = {
        comments: [
            {
                content: reviewText,
                commentType: GitInterfaces.CommentType.Text,
            },
        ],
        status: GitInterfaces.CommentThreadStatus.Active,
    };
    await gitApi.createThread(thread, repoId, prId);
    console.log('✅  Review posted to PR as a comment thread.');
}
// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────
async function main() {
    const cfg = parseArgs();
    console.log('🔗  Connecting to Azure DevOps…');
    const conn = await getConnection(cfg.org, cfg.pat);
    console.log('📄  Fetching PR diff…');
    const { pr, diffParts } = await fetchPrDiff(conn, cfg.repo, cfg.pr);
    console.log('🤖  Sending to AI for review…');
    const prompt = buildPrompt(pr, diffParts);
    const review = await callChatApi(cfg.aiBaseUrl, cfg.aiKey, cfg.aiModel, prompt);
    // ── Output ──────────────────────────────────────────────────────
    if (cfg.output === 'json') {
        // Extract only the JSON portion after ===JSON===
        const jsonDelim = review.indexOf('===JSON===');
        if (jsonDelim !== -1) {
            const jsonStr = review.slice(jsonDelim + '===JSON==='.length).trim();
            if (cfg.outFile) {
                fs.writeFileSync(cfg.outFile, jsonStr, 'utf8');
                console.log(`📁  JSON saved to ${cfg.outFile}`);
            }
            else {
                console.log(jsonStr);
            }
        }
        else {
            console.log(review);
        }
    }
    else {
        if (cfg.outFile) {
            fs.writeFileSync(cfg.outFile, review, 'utf8');
            console.log(`📁  Review saved to ${cfg.outFile}`);
        }
        else {
            console.log('\n' + '═'.repeat(60));
            console.log(review);
            console.log('═'.repeat(60) + '\n');
        }
    }
    // Optionally post back to PR
    const postBack = process.argv.includes('--post');
    if (postBack) {
        console.log('📤  Posting review back to PR…');
        await postReviewToPr(conn, cfg.repo, cfg.pr, review);
    }
}
main().catch((err) => {
    console.error('❌  Error:', err.message || err);
    process.exit(1);
});
//# sourceMappingURL=review-pr.js.map