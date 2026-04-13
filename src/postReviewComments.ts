import * as vscode from 'vscode';
import * as GitInterfaces from 'azure-devops-node-api/interfaces/GitInterfaces';
import { AdoClient } from './adoClient';
import { PrNode } from './prTreeDataProvider';

// ── JSON schema types ────────────────────────────────────────────────

export interface ReviewMeta {
  schemaVersion: string;
  prId: number;
  summary: string;
  overallRisk: 'low' | 'medium' | 'high';
  confidence: number;
}

export interface ReviewCheck {
  status: 'pass' | 'warn' | 'fail';
  note: string | null;
}

export interface ReviewComment {
  id: string;
  severity: 'blocker' | 'high' | 'medium' | 'low' | 'nit';
  category:
  | 'bug'
  | 'security'
  | 'performance'
  | 'style'
  | 'maintainability'
  | 'testing'
  | 'docs';
  filePath: string;
  side: 'RIGHT' | 'LEFT';
  line: number | null;
  startLine: number | null;
  endLine: number | null;
  title: string;
  message: string;
  suggestion: string | null;
  rationale: string | null;
}

export interface GeneralSuggestion {
  title: string;
  message: string;
}

export interface ReviewPayload {
  meta: ReviewMeta;
  checks: {
    bugs: ReviewCheck;
    security: ReviewCheck;
    performance: ReviewCheck;
    maintainability: ReviewCheck;
    tests: ReviewCheck;
  };
  comments: ReviewComment[];
  generalSuggestions: GeneralSuggestion[];
}

// ── Severity → emoji mapping ─────────────────────────────────────────

const SEVERITY_EMOJI: Record<string, string> = {
  blocker: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
  nit: '⚪',
};

const CHECK_EMOJI: Record<string, string> = {
  pass: '✅',
  warn: '⚠️',
  fail: '❌',
};

const RISK_EMOJI: Record<string, string> = {
  low: '🟢',
  medium: '🟡',
  high: '🔴',
};

// ── Parse the AI response ────────────────────────────────────────────

/**
 * Try to parse a string as JSON. Returns the parsed object or undefined.
 */
function tryParseJson(str: string): any | undefined {
  try {
    return JSON.parse(str);
  } catch {
    return undefined;
  }
}

/**
 * Extract the JSON block from the AI response text.
 * Tries multiple strategies to locate valid JSON within the response:
 *   1. ===JSON=== delimiter
 *   2. Markdown ```json fenced code block
 *   3. First occurrence of `{"meta"` pattern
 *   4. Outermost { … } brace matching
 *   5. Raw text as-is
 */
export function extractReviewJson(text: string): ReviewPayload {
  const candidates: string[] = [];

  // ── Strategy 1: ===JSON=== delimiter ─────────────────────────────
  const delimIdx = text.indexOf('===JSON===');
  if (delimIdx !== -1) {
    let after = text.substring(delimIdx + '===JSON==='.length).trim();
    // Strip markdown fences if wrapping the JSON
    after = stripMarkdownFences(after);
    candidates.push(after);
  }

  // ── Strategy 2: Markdown ```json ... ``` fenced code block ───────
  const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRegex.exec(text)) !== null) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith('{')) {
      candidates.push(inner);
    }
  }

  // ── Strategy 3: Find first `{"meta"` occurrence ─────────────────
  const metaIdx = text.indexOf('{"meta"');
  if (metaIdx !== -1) {
    const fromMeta = text.substring(metaIdx);
    const extracted = extractOutermostBraces(fromMeta);
    if (extracted) {
      candidates.push(extracted);
    }
  }

  // ── Strategy 4: Outermost { … } brace matching on full text ─────
  const outermost = extractOutermostBraces(text);
  if (outermost) {
    candidates.push(outermost);
  }

  // ── Strategy 5: Raw text (stripped of fences) ────────────────────
  candidates.push(stripMarkdownFences(text.trim()));

  // Try each candidate in order
  const parseErrors: string[] = [];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && parsed.meta) {
        validateReviewPayload(parsed);
        return parsed;
      } else if (parsed && typeof parsed === 'object') {
        parseErrors.push(
          `Found JSON object but missing "meta" field. Keys: ${Object.keys(parsed).join(', ')}`,
        );
      }
    } catch (e) {
      // Track first 100 chars of candidate for debugging
      const preview = candidate.substring(0, 100).replace(/\n/g, '\\n');
      parseErrors.push(`JSON parse error near: "${preview}..." - ${e}`);
    }
  }

  // Provide detailed error info
  const clipboardPreview = text.substring(0, 200).replace(/\n/g, '\\n');
  const errorDetails = [
    'Could not find valid review JSON.',
    '',
    `Clipboard preview: "${clipboardPreview}..."`,
    '',
    `Tried ${candidates.length} extraction strategies.`,
    parseErrors.length > 0 ? `Errors: ${parseErrors[0]}` : '',
  ].join('\n');

  throw new Error(errorDetails);
}

/**
 * Strip wrapping markdown code fences (```json ... ``` or ``` ... ```)
 */
function stripMarkdownFences(str: string): string {
  return str.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```\s*$/i, '');
}

/**
 * Given a string starting at (or containing) `{`, find the matching `}`
 * by counting braces — handles nested objects. Returns the substring
 * from the first `{` through its matching `}`, or undefined.
 */
function extractOutermostBraces(str: string): string | undefined {
  const startIdx = str.indexOf('{');
  if (startIdx === -1) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < str.length; i++) {
    const ch = str[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return str.substring(startIdx, i + 1);
      }
    }
  }

  return undefined;
}

function validateReviewPayload(obj: any): asserts obj is ReviewPayload {
  if (!obj.meta || typeof obj.meta.summary !== 'string') {
    throw new Error('Missing or invalid "meta" section in review JSON.');
  }
  if (!obj.checks) {
    throw new Error('Missing "checks" section in review JSON.');
  }
  if (!Array.isArray(obj.comments)) {
    throw new Error('Missing or invalid "comments" array in review JSON.');
  }
}

// ── Build markdown content for a single comment thread ───────────────

export function buildCommentBody(comment: ReviewComment): string {
  const emoji = SEVERITY_EMOJI[comment.severity] ?? '';
  const lines: string[] = [];

  lines.push(
    `### ${emoji} [${comment.severity.toUpperCase()}] ${comment.title}`,
  );
  lines.push('');
  lines.push(`**Category:** ${comment.category}`);
  lines.push('');
  lines.push(comment.message);

  if (comment.suggestion) {
    lines.push('');
    lines.push('**Suggestion:**');
    lines.push(comment.suggestion);
  }

  if (comment.rationale) {
    lines.push('');
    lines.push(`> 💡 *${comment.rationale}*`);
  }

  return lines.join('\n');
}

// ── Build the summary comment ────────────────────────────────────────

export function buildSummaryComment(review: ReviewPayload): string {
  const riskEmoji = RISK_EMOJI[review.meta.overallRisk] ?? '';
  const lines: string[] = [];

  lines.push('# 🤖 AI Code Review Summary');
  lines.push('');
  lines.push(
    `**Overall Risk:** ${riskEmoji} ${review.meta.overallRisk.toUpperCase()}`,
  );
  lines.push(`**Confidence:** ${(review.meta.confidence * 100).toFixed(0)}%`);
  lines.push('');
  lines.push(review.meta.summary);
  lines.push('');

  // Checks table
  lines.push('## Quality Checks');
  lines.push('');
  lines.push('| Check | Status | Note |');
  lines.push('|-------|--------|------|');
  for (const [name, check] of Object.entries(review.checks)) {
    const emoji = CHECK_EMOJI[check.status] ?? '';
    lines.push(`| ${name} | ${emoji} ${check.status} | ${check.note ?? '—'} |`);
  }
  lines.push('');

  // Comments breakdown
  if (review.comments.length > 0) {
    lines.push('## Inline Comments');
    lines.push('');
    const bySeverity = new Map<string, number>();
    for (const c of review.comments) {
      bySeverity.set(c.severity, (bySeverity.get(c.severity) ?? 0) + 1);
    }
    const severityOrder = ['blocker', 'high', 'medium', 'low', 'nit'];
    for (const sev of severityOrder) {
      const count = bySeverity.get(sev);
      if (count) {
        lines.push(`- ${SEVERITY_EMOJI[sev]} **${sev}**: ${count}`);
      }
    }
    lines.push('');
  }

  // General suggestions
  if (review.generalSuggestions?.length) {
    lines.push('## General Suggestions');
    lines.push('');
    for (const s of review.generalSuggestions) {
      lines.push(`### 💡 ${s.title}`);
      lines.push(s.message);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('*Generated by AI Code Review*');

  return lines.join('\n');
}

// ── Map severity to ADO thread status ────────────────────────────────

export function severityToThreadStatus(
  severity: string,
): GitInterfaces.CommentThreadStatus {
  switch (severity) {
    case 'blocker':
    case 'high':
      return GitInterfaces.CommentThreadStatus.Active;
    default:
      return GitInterfaces.CommentThreadStatus.Active;
  }
}

// ── Build thread context for file-level comments ─────────────────────

export function buildThreadContext(
  comment: ReviewComment,
): GitInterfaces.CommentThreadContext | undefined {
  if (!comment.filePath) {
    return undefined;
  }

  const ctx: GitInterfaces.CommentThreadContext = {
    filePath: comment.filePath,
  };

  const startLine = comment.startLine ?? comment.line;
  const endLine = comment.endLine ?? comment.line;

  if (startLine !== null && endLine !== null) {
    if (comment.side === 'LEFT') {
      ctx.leftFileStart = { line: startLine, offset: 1 };
      ctx.leftFileEnd = { line: endLine, offset: 1 };
    } else {
      // Default to RIGHT side
      ctx.rightFileStart = { line: startLine, offset: 1 };
      ctx.rightFileEnd = { line: endLine, offset: 1 };
    }
  }

  return ctx;
}

// ── Main entry point ─────────────────────────────────────────────────

/**
 * Parse the AI review JSON (from clipboard, open editor, or provided text) and post
 * each comment as a separate thread on the Azure DevOps PR.
 */
export async function postReviewCommentsFromJson(
  node: PrNode,
  jsonText?: string,
): Promise<void> {
  const client = new AdoClient(node.orgUrl);
  const prId = node.pr.pullRequestId!;

  // 1. Get the review text from multiple sources
  let reviewText = jsonText;

  if (!reviewText) {
    // Try clipboard first
    const clipboardText = await vscode.env.clipboard.readText();

    // Check if clipboard has valid-looking review JSON
    if (
      clipboardText?.trim() &&
      (clipboardText.includes('"meta"') ||
        clipboardText.includes('===JSON===') ||
        clipboardText.includes('```json'))
    ) {
      reviewText = clipboardText;
    }
  }

  if (!reviewText) {
    // Try active editor selection or full content
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const selection = editor.selection;
      if (!selection.isEmpty) {
        reviewText = editor.document.getText(selection);
      } else {
        // Check if active document contains review JSON
        const docText = editor.document.getText();
        if (docText.includes('"meta"') || docText.includes('===JSON===')) {
          reviewText = docText;
        }
      }
    }
  }

  if (!reviewText?.trim()) {
    // Show input box as last resort
    const action = await vscode.window.showWarningMessage(
      'No review JSON found in clipboard or active editor. ' +
      'Copy the AI review response (including the JSON block) and try again.',
      'Paste from Clipboard Again',
      'Open Input Box',
    );

    if (action === 'Paste from Clipboard Again') {
      reviewText = await vscode.env.clipboard.readText();
    } else if (action === 'Open Input Box') {
      // Create a new untitled document for the user to paste into
      const doc = await vscode.workspace.openTextDocument({
        language: 'json',
        content:
          '// Paste the AI review JSON here and save, then run the command again\n',
      });
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(
        'Paste the AI review JSON into the editor, then run "ADO: Post Structured AI Review" again.',
      );
      return;
    } else {
      return;
    }
  }

  if (!reviewText?.trim()) {
    vscode.window.showErrorMessage(
      'No review text found. Copy the AI review response to your clipboard first.',
    );
    return;
  }

  // 2. Parse the JSON
  let review: ReviewPayload;
  try {
    review = extractReviewJson(reviewText);
  } catch (err) {
    vscode.window.showErrorMessage(`${err}`);
    return;
  }

  // 3. Show confirmation
  const totalComments = review.comments.length;
  const hasSuggestions = (review.generalSuggestions?.length ?? 0) > 0;
  const description = [
    `Post AI review to PR #${prId}?`,
    `• ${totalComments} inline comment${totalComments !== 1 ? 's' : ''}`,
    `• 1 summary comment`,
    hasSuggestions
      ? `• ${review.generalSuggestions.length} general suggestion${review.generalSuggestions.length !== 1 ? 's' : ''}`
      : '',
    `• Overall risk: ${review.meta.overallRisk}`,
  ]
    .filter(Boolean)
    .join('\n');

  const action = await vscode.window.showInformationMessage(
    description,
    { modal: true },
    'Post All Comments',
    'Post Summary Only',
  );

  if (!action) {
    return;
  }

  // 4. Post comments with progress
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Posting AI review comments…',
      cancellable: false,
    },
    async (progress) => {
      let posted = 0;
      const totalToPost =
        action === 'Post All Comments'
          ? totalComments + 1 // +1 for summary
          : 1; // summary only

      try {
        // Post summary comment (always)
        progress.report({
          message: 'Posting summary…',
          increment: 0,
        });

        const summaryContent = buildSummaryComment(review);
        await client.addPullRequestComment(node.repoId, prId, summaryContent);
        posted++;
        progress.report({
          increment: (1 / totalToPost) * 100,
        });

        // Post inline comments
        if (action === 'Post All Comments' && review.comments.length > 0) {
          for (const comment of review.comments) {
            progress.report({
              message: `Posting comment ${posted}/${totalToPost}: ${comment.title}`,
            });

            const body = buildCommentBody(comment);
            const threadContext = buildThreadContext(comment);

            await client.addPullRequestThreadComment(
              node.repoId,
              prId,
              body,
              threadContext,
              severityToThreadStatus(comment.severity),
            );

            posted++;
            progress.report({
              increment: (1 / totalToPost) * 100,
            });
          }
        }

        vscode.window.showInformationMessage(
          `Successfully posted ${posted} comment${posted !== 1 ? 's' : ''} to PR #${prId}`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Error posting comments (${posted}/${totalToPost} succeeded): ${err}`,
        );
      }
    },
  );
}
