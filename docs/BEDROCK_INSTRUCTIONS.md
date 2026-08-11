# Using Claude through Amazon Bedrock

Operator supports one Claude provider per instance. Configure the instance for
either Amazon Bedrock or a Claude subscription/API key; do not mix them in the
same running instance.

These instructions assume you have just cloned Operator and want to run it
locally.

## Install and open the repository

```bash
cd operator-oss
npm install
```

Then choose one of the following authentication approaches.

## Approach 1: Bedrock API key

Set the Bedrock provider and AWS region in the shell that will launch Operator:

```bash
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION=us-east-1
```

Enter the Bedrock API key without putting it in shell history. In `zsh`:

```zsh
read -s "AWS_BEARER_TOKEN_BEDROCK?Bedrock API key: "
echo
export AWS_BEARER_TOKEN_BEDROCK
```

In `bash`:

```bash
read -rsp "Bedrock API key: " AWS_BEARER_TOKEN_BEDROCK
echo
export AWS_BEARER_TOKEN_BEDROCK
```

Start Operator from that same shell:

```bash
npm run dev
```

The exported values apply only to that shell session. If you persist them,
store the API key in an approved secret manager or private shell configuration;
never commit it to the repository.

## Approach 2: AWS SSO profile

This approach uses the standard AWS credential chain and does not require
`AWS_BEARER_TOKEN_BEDROCK`.

Make sure your company-provided `claude` AWS profile is configured in
`~/.aws/config`. Then add the Bedrock environment to
`~/.claude/settings.json`, preserving any other settings already in the file:

```json
{
  "env": {
    "CLAUDE_CODE_USE_BEDROCK": "1",
    "AWS_PROFILE": "claude",
    "AWS_REGION": "us-east-1"
  }
}
```

Refresh the SSO session:

```bash
aws sso login --profile claude --use-device-code --no-browser
```

Open the URL printed by the command and enter its device code. Confirm Claude
can start through Bedrock:

```bash
claude
```

If your company configuration automatically starts the SSO device flow when
Claude needs fresh credentials, that behavior remains available. Logging in
before starting Operator avoids requiring an interactive refresh from a
background request.

Start Operator:

```bash
npm run dev
```

When the SSO session expires, run the same `aws sso login` command again.

## Verify Bedrock in Operator

1. Open [http://localhost:3000](http://localhost:3000).
2. Go to **Settings → Agents → Amazon Bedrock**.
3. Select **Verify**.

You can optionally enter a Bedrock model ID, cross-region inference profile ID,
or application inference-profile ARN from a task's **Custom model** picker.

Do not set `ANTHROPIC_API_KEY` or perform Claude subscription login on this
Operator instance while Bedrock is enabled.
