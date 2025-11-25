import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';              // for existsSync etc
import { promises as fsp } from 'fs'; // for await fsp.readFile / writeFile
import * as yaml from 'js-yaml';
import simpleGit, { SimpleGit } from 'simple-git';
import { Octokit } from '@octokit/rest';
import { sync as globSync } from 'glob';




type ParsedPrompt = {
  flagName: string;
  value: any;
  environment?: string;
  region?: string;
};


/**
 * Walk up from `start` until a directory containing .git is found.
 * Returns the path to the git top-level folder, or undefined if not found.
 */
function findGitRoot(start: string): string | undefined {
  let cur = path.resolve(start);
  const root = path.parse(cur).root;
  while (true) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    if (cur === root) return undefined;
    cur = path.dirname(cur);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('flagUpdatePr.update', async () => {
    try {
      // prefer opened workspace, but when running in Extension Dev Host fall back to the extension dev path
      const workspaceFolders = vscode.workspace.workspaceFolders;
      let root: string | undefined;
      if (workspaceFolders && workspaceFolders.length > 0) {
        root = workspaceFolders[0].uri.fsPath;
      } else {
        // context.extensionUri points to the folder passed via --extensionDevelopmentPath
        root = context.extensionUri?.fsPath;
      }

      if (!root) {
        vscode.window.showErrorMessage('Open a workspace folder first or ensure extension development path is available.');
        return;
      }

      console.log('Using root for operations:', root);

      // ----------------- prompt + parsing -----------------
      const prompt = await vscode.window.showInputBox({
        prompt: 'Enter update prompt (e.g. "onUPDATE volumeQuotaFlag to false for stage environment and delhi region")',
        placeHolder: 'onUPDATE volumeQuotaFlag to false for stage environment and delhi region'
      });
      if (!prompt) {
        vscode.window.showInformationMessage('Cancelled.');
        return;
      }

      const parsed = parsePrompt(prompt);
      if (!parsed) {
        vscode.window.showErrorMessage('Could not parse the prompt. Expected format: onUPDATE <flag> to <value> for <env> environment and <region> region');
        return;
      }

      // ----------------- file selection & update -----------------
      const candidates = await findCandidateFiles(root);
      if (candidates.length === 0) {
        vscode.window.showErrorMessage('No candidate JSON/YAML config files found in workspace.');
        return;
      }

      const filePick = await vscode.window.showQuickPick(candidates.map(c => path.relative(root!, c)), {
        placeHolder: 'Pick file to update'
      });
      if (!filePick) {
        vscode.window.showInformationMessage('Cancelled.');
        return;
      }
      const filePath = path.join(root, filePick);

      await updateFileFlag(filePath, parsed);

      // ----------------- Git operations -----------------
      const repoRoot = findGitRoot(root);
      if (!repoRoot) {
        vscode.window.showErrorMessage(`No git repository found starting at ${root}. Initialize git or open the correct folder.`);
        return;
      }
      console.log('Using git repo root:', repoRoot);
      const git: SimpleGit = simpleGit(repoRoot);
      const branchPrefix = vscode.workspace.getConfiguration('flagUpdatePr').get('branchPrefix') as string || 'flag-update';
      const branchName = `${branchPrefix}/${parsed.flagName}-${Date.now()}`;

      await git.checkoutLocalBranch(branchName);
      await git.add([filePath]);
      await git.commit(`Update ${parsed.flagName} to ${parsed.value}`);
      await git.push('origin', branchName);

      // ----------------- Create PR -----------------
      const token = getToken();
      if (!token) {
        vscode.window.showWarningMessage('No GitHub token found. Set flagUpdatePr.githubToken or environment GITHUB_TOKEN to create PR. Branch was pushed.');
        return;
      }

      const remotes = await git.getRemotes(true);
      const origin = remotes.find(r => r.name === 'origin');
      if (!origin || !origin.refs.fetch) {
        vscode.window.showErrorMessage('No origin remote found.');
        return;
      }
      const { owner, repo } = parseGitHubRepo(origin.refs.fetch);
      if (!owner || !repo) {
        vscode.window.showErrorMessage('Could not parse GitHub repo from remote URL.');
        return;
      }

      const octokit = new Octokit({ auth: token });
      const defaultBranch = (await octokit.repos.get({ owner, repo })).data.default_branch;

      const pr = await octokit.pulls.create({
        owner,
        repo,
        title: `Update ${parsed.flagName} -> ${parsed.value} (${parsed.environment ?? ''} ${parsed.region ?? ''})`,
        head: branchName,
        base: defaultBranch,
        body: `Automated update by VS Code extension.\n\nPrompt: ${prompt}`
      });

      vscode.window.showInformationMessage(`PR created: ${pr.data.html_url}`);
      vscode.env.openExternal(vscode.Uri.parse(pr.data.html_url));

    } catch (err: any) {
      vscode.window.showErrorMessage(`Error: ${err.message || err}`);
      console.error(err);
    }
  });

  context.subscriptions.push(disposable);
}


export function deactivate() {}

/* ---------- Helpers ---------- */

function parsePrompt(input: string): ParsedPrompt | null {
  // Very simple parser tuned for the example grammar.
  // Example: onUPDATE volumeQuotaFlag to false for stage environment and delhi region
  const lower = input.trim();
  const updateMatch = /onUPDATE\s+([^\s]+)\s+to\s+([^\s]+)(?:\s+for\s+([^\s]+)\s+environment)?(?:\s+and\s+([^\s]+)\s+region)?/i;
  const m = updateMatch.exec(lower);
  if (!m) return null;
  let [, flagName, valueRaw, environment, region] = m;
  let value: any = valueRaw;
  if (valueRaw === 'true' || valueRaw === 'false') value = (valueRaw === 'true');
  else if (!isNaN(Number(valueRaw))) value = Number(valueRaw);
  return { flagName, value, environment, region };
}

function findCandidateFiles(root: string): Promise<string[]> {
  const patterns = ['**/*config*.json', '**/*.json', '**/*.yaml', '**/*.yml'];
  const opts = { cwd: root, absolute: true, ignore: ['node_modules/**'] as any };

  const results: string[] = [];
  for (const p of patterns) {
    try {
      const files = globSync(p, opts);
      if (files && files.length) results.push(...files);
    } catch (err) {
      // ignore pattern errors but log for debugging
      console.warn('glob pattern error', p, err);
    }
  }

  const uniq = Array.from(new Set(results));
  uniq.sort((a, b) => (path.basename(a).toLowerCase().includes('config') ? -1 : 1));
  return Promise.resolve(uniq);
}

async function updateFileFlag(filePath: string, parsed: ParsedPrompt) {
  const ext = path.extname(filePath).toLowerCase();
  const raw = await fsp.readFile(filePath, 'utf8'); // returns string

  if (ext === '.json') {
    const json = JSON.parse(raw);
    setNestedValue(json, parsed.flagName, parsed.value);
    const formatted = JSON.stringify(json, null, 2);
    await fsp.writeFile(filePath, formatted, 'utf8');
  } else if (ext === '.yaml' || ext === '.yml') {
    const doc = yaml.load(raw) as any;
    setNestedValue(doc, parsed.flagName, parsed.value);
    const out = yaml.dump(doc, { noRefs: true });
    await fsp.writeFile(filePath, out, 'utf8');
  } else {
    try {
      const json = JSON.parse(raw);
      setNestedValue(json, parsed.flagName, parsed.value);
      await fsp.writeFile(filePath, JSON.stringify(json, null, 2), 'utf8');
    } catch {
      const replaced = raw.replace(
        new RegExp(`${parsed.flagName}\\s*:\\s*[^\\n\\r,]+`, 'i'),
        `${parsed.flagName}: ${parsed.value}`
      );
      await fsp.writeFile(filePath, replaced, 'utf8');
    }
  }
}




function setNestedValue(obj: any, dottedKey: string, value: any) {
  // supports dot notation (e.g., a.b.c) or simple key
  const keys = dottedKey.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (i === keys.length - 1) {
      cur[k] = value;
    } else {
      if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
      cur = cur[k];
    }
  }
}

function getToken(): string | undefined {
  const cfg = vscode.workspace.getConfiguration('flagUpdatePr').get('githubToken') as string | undefined;
  return cfg && cfg.length ? cfg : process.env.GITHUB_TOKEN;
}

function parseGitHubRepo(remoteUrl: string): { owner?: string; repo?: string } {
  // formats:
  // git@github.com:owner/repo.git
  // https://github.com/owner/repo.git
  const sshMatch = /git@github.com:([^\/]+)\/(.+)\.git/;
  const httpsMatch = /https?:\/\/github.com\/([^\/]+)\/(.+)\.git/;
  let m = sshMatch.exec(remoteUrl);
  if (m) return { owner: m[1], repo: m[2] };
  m = httpsMatch.exec(remoteUrl);
  if (m) return { owner: m[1], repo: m[2] };
  // sometimes remoteUrl is without .git
  const ssh2 = /git@github.com:([^\/]+)\/(.+)/;
  const https2 = /https?:\/\/github.com\/([^\/]+)\/(.+)/;
  m = ssh2.exec(remoteUrl) || https2.exec(remoteUrl);
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
  return {};
}
