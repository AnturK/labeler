import * as core from "@actions/core";
import * as github from "@actions/github";
import * as yaml from "js-yaml";
import { Minimatch } from "minimatch";
import { labeledStatement, thisExpression } from "@babel/types";

class LabelerKey {
  type: string;
  label: string;
  constructor(label: string, type: string = "filesChanged") {
    this.type = type;
    this.label = label;
  }
}

async function run() {
  try {
    const token = core.getInput("repo-token", { required: true });
    const configPath = core.getInput("configuration-path", { required: true });

    const prNumber = getPrNumber();
    if (!prNumber) {
      console.log("Could not get pull request number from context, exiting");
      return;
    }

    const client = new github.GitHub(token);

    core.debug(`fetching changed files for pr #${prNumber}`);
    const changedFiles: string[] = await getChangedFiles(client, prNumber);
    const prTitle = await getTitle(client, prNumber);
    const labelGlobs: Map<LabelerKey, string[]> = await getLabelGlobs(
      client,
      configPath
    );

    const labels: string[] = [];
    for (const [label, globs] of labelGlobs.entries()) {
      core.debug(`processing ${label}`);
      if (label.type === "filesChanged") {
        if (checkGlobs(changedFiles, globs)) {
          labels.push(label.label);
        }
      } else if (label.type == "title") {
        if (checkGlobs([prTitle], globs)) {
          labels.push(label.label);
        }
      }
    }

    if (labels.length > 0) {
      await addLabels(client, prNumber, labels);
    }
  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
  }
}

function getPrNumber(): number | undefined {
  const pullRequest = github.context.payload.pull_request;
  if (!pullRequest) {
    return undefined;
  }
  return pullRequest.number;
}

async function getChangedFiles(
  client: github.GitHub,
  prNumber: number
): Promise<string[]> {
  const listFilesResponse = await client.pulls.listFiles({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: prNumber
  });

  const changedFiles = listFilesResponse.data.map(f => f.filename);

  core.debug("found changed files:");
  for (const file of changedFiles) {
    core.debug("  " + file);
  }

  return changedFiles;
}

async function getTitle(
  client: github.GitHub,
  prNumber: number
): Promise<string> {
  const getResponse = await client.pulls.get({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: prNumber
  });

  const title = getResponse.data.title;

  return title;
}

async function getLabelGlobs(
  client: github.GitHub,
  configurationPath: string
): Promise<Map<LabelerKey, string[]>> {
  const configurationContent: string = await fetchContent(
    client,
    configurationPath
  );

  // loads (hopefully) a `{[label:string]: string | string[]}`, but is `any`:
  const configObject: any = yaml.safeLoad(configurationContent);

  // transform `any` => `Map<string,string[]>` or throw if yaml is malformed:
  return getLabelGlobMapFromObject(configObject);
}

async function fetchContent(
  client: github.GitHub,
  repoPath: string
): Promise<string> {
  const response = await client.repos.getContents({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    path: repoPath,
    ref: github.context.sha
  });

  return Buffer.from(response.data.content, "base64").toString();
}

function getLabelGlobMapFromObject(
  configObject: any
): Map<LabelerKey, string[]> {
  const labelGlobs: Map<LabelerKey, string[]> = new Map();
  for (const label in configObject) {
    let keytype: string = "filesChanged";
    if (typeof configObject[label]["type"] === "string") {
      keytype = configObject[label]["type"];
    }
    if (typeof configObject[label]["patterns"] === "string") {
      labelGlobs.set(new LabelerKey(label, keytype), [
        configObject[label]["patterns"]
      ]);
    } else if (configObject[label]["patterns"] instanceof Array) {
      labelGlobs.set(
        new LabelerKey(label, keytype),
        configObject[label]["patterns"]
      );
    } else {
      throw Error(
        `found unexpected type for label patterns ${label} (should be string or array of globs)`
      );
    }
  }

  return labelGlobs;
}

function checkGlobs(changedFiles: string[], globs: string[]): boolean {
  for (const glob of globs) {
    core.debug(` checking pattern ${glob}`);
    const matcher = new Minimatch(glob);
    for (const changedFile of changedFiles) {
      core.debug(` - ${changedFile}`);
      if (matcher.match(changedFile)) {
        core.debug(` ${changedFile} matches`);
        return true;
      }
    }
  }
  return false;
}

async function addLabels(
  client: github.GitHub,
  prNumber: number,
  labels: string[]
) {
  await client.issues.addLabels({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: prNumber,
    labels: labels
  });
}

run();
