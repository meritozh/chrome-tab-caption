# PR review (Cursor Bugbot)

Cursor Bugbot reviews pull requests on this repository and reports a GitHub check named **`Cursor Bugbot`**.

## Behavior

- **Automatic:** Bugbot reviews on each PR update (new commits / synchronize).
- **Manual:** Comment `cursor review` or `bugbot run` on the PR (human comments only; GitHub App / bot accounts are ignored).
- **Required check name:** `Cursor Bugbot`

Findings default to a **neutral** check conclusion. Requiring the check in branch protection ensures the review **ran**; it does not block merge solely because Bugbot left findings (unless fail-on-unresolved-issues is enabled for your Cursor org).

## Enable Bugbot (repo owner)

1. Open [Cursor Integrations](https://cursor.com/dashboard?tab=integrations) and confirm GitHub is connected for `meritozh/chrome-tab-caption` ([GitHub App](https://github.com/apps/cursor)).
2. Open [Bugbot / Automations](https://cursor.com/dashboard?tab=bugbot) and enable Bugbot for **`meritozh/chrome-tab-caption`**.
3. Smoke-test: open any open PR (e.g. [#1](https://github.com/meritozh/chrome-tab-caption/pull/1)) and comment `cursor review`, or push a new commit. Confirm the **`Cursor Bugbot`** check appears on the PR Checks tab.

Docs: [Bugbot](https://cursor.com/docs/bugbot) · [GitHub integration](https://cursor.com/docs/integrations/github)

## Optional: require the check on `main`

GitHub path: **Settings → Branches → Branch protection rules** → rule for `main` → enable **Require status checks to pass before merging** → add **`Cursor Bugbot`**. Do not add approval requirements unless they already exist.

API equivalent (repo admin token):

```bash
gh api --method PUT repos/meritozh/chrome-tab-caption/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Cursor Bugbot"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF
```

Note: the status check must have appeared on at least one recent commit before GitHub lists it for selection in the UI.
