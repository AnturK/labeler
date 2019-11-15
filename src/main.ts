import * as core from "@actions/core";
import * as github from "@actions/github";
import * as yaml from "js-yaml";
import { Minimatch } from "minimatch";
import { labeledStatement, thisExpression } from "@babel/types";

const enum LabelType {
  filesChanged = "filesChanged", //Apply the label if files changed matches the pattern
  title = "title", //Apply the label if the pr title matches the pattern
  mergeState = "mergeState", //Apply if the pr is in umergable state
  alwaysRemove = "alwaysRemove" //Always remove this label on update
}

class LabelerKey {
  type: LabelType;
  label: string;
  removable: boolean = false;
  opened_only: boolean = false;
  constructor(
    label: string,
    type: LabelType = LabelType.filesChanged,
    removable: boolean = false,
    opened_only: boolean = false
  ) {
    this.type = type;
    this.label = label;
    this.removable = removable;
    this.opened_only = opened_only;
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

    const action = github.context.payload.action;

    const client = new github.GitHub(token);

    core.debug(`fetching changed files for pr #${prNumber}`);
    const changedFiles: string[] = await getChangedFiles(client, prNumber);
    const [prTitle, current_labels, mergeable] = await getPrInfo(
      client,
      prNumber
    );
    const labelGlobs: Map<LabelerKey, string[]> = await getLabelGlobs(
      client,
      configPath
    );

    const labels_to_add: string[] = [];
    const labels_to_remove: string[] = [];
    for (const [label, globs] of labelGlobs.entries()) {
      if (label.opened_only && action !== "opened") {
        continue;
      }
      core.debug(`processing ${label}`);
      switch (label.type) {
        case LabelType.filesChanged:
          if (checkGlobs(changedFiles, globs)) {
            labels_to_add.push(label.label);
          } else if (label.removable) {
            labels_to_remove.push(label.label);
          }
          break;
        case LabelType.alwaysRemove:
          labels_to_remove.push(label.label);
          break;
        case LabelType.mergeState:
          if (!mergeable) labels_to_add.push(label.label);
          else if (label.removable) labels_to_remove.push(label.label);
          break;
        case LabelType.title:
          if (checkGlobs([prTitle], globs)) {
            labels_to_add.push(label.label);
          } else if (label.removable) {
            labels_to_remove.push(label.label);
          }
          break;
      }
    }

    if (labels_to_add.length > 0 || labels_to_remove.length > 0) {
      await updateLabels(
        client,
        prNumber,
        current_labels,
        labels_to_add,
        labels_to_remove
      );
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

async function getPrInfo(
  client: github.GitHub,
  prNumber: number
): Promise<[string, string[], boolean]> {
  const getResponse = await client.pulls.get({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: prNumber
  });

  const title = getResponse.data.title;
  const labels = getResponse.data.labels.map(p => {
    return p.name;
  });
  const mergeable = getResponse.data.mergeable;

  return [title, labels, mergeable];
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
    let keytype: LabelType = LabelType.filesChanged;
    if (typeof configObject[label]["type"] === "string") {
      keytype = configObject[label]["type"];
    }
    let removable: boolean = false;
    if (typeof configObject[label]["removable"] === "boolean") {
      removable = configObject[label]["removable"];
    }
    let opened_only: boolean = false;
    if (typeof configObject[label]["opened_only"] === "boolean") {
      opened_only = configObject[label]["opened_only"];
    }
    if (typeof configObject[label]["patterns"] === "string") {
      labelGlobs.set(new LabelerKey(label, keytype, removable, opened_only), [
        configObject[label]["patterns"]
      ]);
    } else if (configObject[label]["patterns"] instanceof Array) {
      labelGlobs.set(
        new LabelerKey(label, keytype, removable, opened_only),
        configObject[label]["patterns"]
      );
    } else if (
      keytype == LabelType.alwaysRemove ||
      keytype == LabelType.mergeState
    ) {
      labelGlobs.set(new LabelerKey(label, keytype, removable, opened_only), [
        "not applicable"
      ]);
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

async function updateLabels(
  client: github.GitHub,
  prNumber: number,
  current_labels: string[],
  labels_to_add: string[],
  labels_to_remove: string[]
) {
  const resulting_labels = [
    ...new Set([...current_labels, ...labels_to_add])
  ].filter(p => {
    return !labels_to_remove.includes(p);
  });

  await client.issues.replaceLabels({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: prNumber,
    labels: resulting_labels
  });
}

run();
