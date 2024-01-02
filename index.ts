import * as core from "@actions/core"
import * as exec from "@actions/exec"
import { EOL } from "os"
import * as semverSort from "semver-sort"

async function getAllRemoteBranches() {
  const { stdout } = await exec.getExecOutput("git ls-remote --heads")

  return stdout
    .toString()
    .split(EOL)
    .filter((b) => b.length > 0)
    .map((b) => b.trim().split("\t")[1]) // gets the branch portion of "4000297aeba4348289cd33eb1a922990ea917749	refs/heads/release-6.7.0"
    .map((b) => b.slice(11)) // remove "refs/heads/" prefix
}

/**
 * Merges the `prevBranch` into `currBranch`. Fails the action if there are merge conflicts with
 * anything other than the VERSION file.
 */
async function mergeBranch({ prevBranch, currBranch }: { prevBranch: string; currBranch: string }) {
  console.log(`Merging ${prevBranch} into ${currBranch}`)

  // Perform merge
  const mergeOutput: exec.ExecOutput = await exec.getExecOutput("git", ["merge", "--no-ff", prevBranch], {
    ignoreReturnCode: true,
  })

  // Check for merge conflict
  // Only resolve conflicts on VERSION file since that is very common
  if (mergeOutput.exitCode > 0) {
    // Resolve conflict on ./VERSION file only
    await exec.exec("git checkout --ours VERSION")
    await exec.exec("git add VERSION")

    // This will fail if there are any other merge conflicts. These should be resolved by developer instead
    // GIT_EDITOR needed so continue can happen without editor
    const mergeContinueOutput: exec.ExecOutput = await exec.getExecOutput("git merge --continue", [], {
      env: { GIT_EDITOR: "/bin/true" },
      ignoreReturnCode: true,
    })
    if (mergeContinueOutput.exitCode > 0) {
      const error = `Failed to merge ${prevBranch} into ${currBranch}`
      core.setOutput("error", error)
      core.setFailed(error)
    }
  }

  await exec.exec(`git push`)
}

async function run() {
  try {
    // Convert input branches to clean list: ["main", "release-*", "dev"]
    const targetBranches: string[] = core
      .getInput("branches", { required: true })
      .split(EOL)
      .map((branch) => branch.trim())

    // Get all remote branches
    const remoteBranches: string[] = await getAllRemoteBranches()

    // Get the remote (commonly "origin")
    const remote: string = (await exec.getExecOutput("git remote")).stdout.toString().trim()

    // Expand regex rule to valid remote branches
    const semverRegex = /(.+-)\d+\.\d+\.\d+/g
    const expandedTargetBranches: string[] = targetBranches
      .map((targetBranchExpression) => {
        const re = new RegExp(`^${targetBranchExpression}$`)
        return remoteBranches.filter((remoteBranch) => re.test(remoteBranch))
      })
      .flatMap((branchGroup) => {
        if (branchGroup.length === 1) return branchGroup

        const match = semverRegex.exec(branchGroup[0])
        if (match) {
          const group = match[1]
          const sorted = semverSort.asc(branchGroup.map((b) => b.slice(group.length)))
          return sorted.map((b) => `${group}${b}`)
        } else {
          return semverSort.asc(branchGroup)
        }
      })

    console.log(`Input branches: ${EOL}- ${targetBranches.join(`${EOL}- `)}`)
    console.log(`Target branches: ${EOL}- ${expandedTargetBranches.join(`${EOL}- `)}`)

    // Need to set who is the committer
    await exec.exec(`git config user.name "GitHub Actions Bot"`)
    await exec.exec(`git config user.email "<>"`)

    // Merge each branch into the next
    for (let index = 0; index < expandedTargetBranches.length; index++) {
      const currBranch = expandedTargetBranches[index]
      await exec.exec(`git fetch ${remote} ${currBranch}`)
      await exec.exec(`git checkout ${currBranch}`)

      // Make sure we're on the latest. This branch may have already been checked out locally, so we need
      // to reset it to the origin. Basically, a very selective "git pull"
      await exec.exec(`git reset --hard ${remote}/${currBranch}`)

      // Nothing to merge into top-level branch
      if (index == 0) continue

      const prevBranch = expandedTargetBranches[index - 1]
      await mergeBranch({ prevBranch, currBranch })
    }
  } catch (exception: any) {
    core.setFailed(exception.message)
  }
}

void run()
