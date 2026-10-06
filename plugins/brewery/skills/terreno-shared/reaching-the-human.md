# Reaching the human

The human is usually not watching the chat. Sign-offs and blockers travel over Slack, text,
or email and come back hours later. Every message must stand alone on a phone screen and
be answerable in one short reply.

## Pick the channel

Use the first one that applies:

1. **zerg drone.** The kickoff said no human is present, or execution state lives under
   `/srv/agent-workspaces/`. Write a `BLOCKED` stage result with one `ask` entry per
   question (`q`, `opts`, `rec`) and `block: [{kind: human, ...}]`, `next: null`, to
   `.terreno/pipeline/<slug>.json`, then stop. zerg files each ask in its inbox, pings
   the phone through ntfy, and delivers the answers as a "Prior human answers" preamble
   on the next prompt. Do not also send the message another way.
2. **A connected messaging tool** (Slack, Gmail, push notification). Send the message
   to the human only: Josh's own Slack DM or his own email address. Never to a channel,
   a teammate, or a customer.
3. **Human in the chat.** Ask with the harness's structured question tool, and still
   print the paste-ready message so it can be forwarded.
4. **None of those.** Print the paste-ready message and the SMS version, record the
   `BLOCKED` result in execution state, and stop.

## Message shape

Plain text. No tables, no headings, no YAML. Links and paths are fine.

```text
[<repo>] <feature title>: <what you need, e.g. "plan ready for sign-off">

<Two or three sentences: what this builds and why, for someone who has forgotten.>

Plan: <IP path or PR link>

Needs an answer:
1. <question>? a) <option> (recommended) b) <option> c) <option>
2. ...

Reply "ok" to accept every recommendation, or e.g. "ok, 2b" / "no: <why>".
```

- Put the questions that block work first, then the ones you already assumed an answer to.
  Cap it at 5. Anything past that, point to the IP's Open questions section.
- The SMS version is at most 480 characters: title, the ask, the plan link, and
  `Reply "ok" or see plan for N open questions`.

## Privacy

Messages leave the HIPAA boundary. Never include PHI, patient or member data, production
record contents, customer names, credentials, or tokens. Describe data by shape ("a
member's care pod assignment"), not by value. If a question cannot be asked without PHI,
ask the human to look at the IP instead.

## Reading the reply

- Map each answer to its question. `ok` accepts every recommendation still open.
- Record each answer in the IP's Decisions table with the question as it was asked.
- An answer that picks nothing concrete ("sure", "whatever", or one that conflicts with
  another answer) stays open. Send one short follow-up through the same channel.
- An answer the human never gave is not accepted. Silence is not sign-off.
