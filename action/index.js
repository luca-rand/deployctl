import * as core from "@actions/core";
import * as github from "@actions/github";
import "./shim.js";
import { API, fromFileUrl, parseEntrypoint, resolve, walk } from "./deps.js";

// The origin of the server to make Deploy requests to.
const ORIGIN = process.env.DEPLOY_API_ENDPOINT ?? "https://dash.deno.com";

async function main() {
  const projectId = core.getInput("project", { required: true });
  const entrypoint = core.getInput("entrypoint", { required: true });
  const cwd = resolve(process.cwd(), core.getInput("cwd", {}));

  const aud = new URL(`/projects/${projectId}`, ORIGIN);
  const token = await core.getIDToken(aud);

  const api = new API(`GitHubOIDC ${token}`, ORIGIN);

  core.info(`Project: ${projectId}`);

  let url = await parseEntrypoint(entrypoint, cwd);
  if (url.protocol === "file:") {
    const path = fromFileUrl(url);
    if (!path.startsWith(cwd)) {
      throw "Entrypoint must be in the current working directory.";
    }
    const entrypoint = path.slice(cwd.length);
    url = new URL(`file:///src${entrypoint}`);
  }
  core.info(`Entrypoint: ${url.href}`);

  core.debug(`Discovering assets in "${cwd}"`);
  const assets = new Map();
  const entries = await walk(cwd, cwd, assets, {
    include: undefined,
    exclude: undefined,
  });
  core.debug(`Discovered ${assets.size} assets`);

  const neededHashes = await api.projectNegotiateAssets(projectId, {
    entries,
  });
  core.debug(`Determined ${neededHashes.length} need to be uploaded`);

  const files = [];
  for (const hash of neededHashes) {
    const path = assets.get(hash);
    if (path === undefined) {
      throw `Asset ${hash} not found.`;
    }
    const data = await Deno.readFile(path);
    files.push(data);
  }
  const totalSize = files.reduce((acc, file) => acc + file.length, 0);
  core.info(
    `Uploading ${neededHashes.length} file(s) (total ${totalSize} bytes)`,
  );

  const manifest = { entries };
  core.debug(`Manifest: ${JSON.stringify(manifest, null, 2)}`);
 
  const req = {
    url: url.href,
    manifest,
    event: github.context.payload,
  };
  const progress = api.pushDeploy(projectId, req, files);
  let deployment;
  for await (const event of progress) {
    switch (event.type) {
      case "staticFile": {
        const percentage = (event.currentBytes / event.totalBytes) * 100;
        core.info(
          `Uploading ${files.length} asset(s) (${percentage.toFixed(1)}%)`,
        );
        break;
      }
      case "load": {
        const progress = event.seen / event.total * 100;
        core.info(`Deploying... (${progress.toFixed(1)}%)`);
        break;
      }
      case "uploadComplete":
        core.info("Finishing deployment...");
        break;
      case "success":
        core.info("Deployment complete.");
        core.info("\nView at:");
        for (const { domain } of event.domainMappings) {
          core.info(` - https://${domain}`);
        }
        deployment = event;
        break;
      case "error":
        throw event.ctx;
    }
  }

  core.setOutput("deployment-id", deployment.id);
  const domain = deployment.domainMappings[0].domain;
  core.setOutput("url", `https://${domain}/`);
}

try {
  await main();
} catch (error) {
  core.setFailed(error);
}
