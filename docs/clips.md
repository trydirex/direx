# Clips

A clip is a short captioned piece of a longer recording, such as a talk or a podcast. You upload
the recording to a Campaign step, and Direx cuts clips from it and drafts a social post for each.
Nothing is posted until someone approves it.

Clipping needs a self-hosted Direx for now. The server needs `ffmpeg` and `whisper-cli` installed,
and it downloads the speech model from huggingface.co the first time.

## Making clips

1. In the Campaign, open the Drafts tab.
2. On the step, open "Change setup", set Type to "Video clips from a recording" and save.
3. Under Recording, upload the video. MP4, MOV and WebM files work, up to 90 minutes long.
4. Under "Post to", tick the accounts to post on. The ones the last recording used are ticked for
   you.
5. Set First post, then press "Make clips".

The step shows what Direx is doing: transcribing the recording, picking the moments worth posting,
then cutting the clips. This takes a few minutes, and you can leave the page. If it stops, the step
says why and offers "Try again".

## How Direx picks the moments

Direx transcribes the recording on your server. An agent reads the transcript with your Facts and
the measures of the Campaign's Marketing plan, and proposes moments. It treats the transcript as
data and doesn't follow instructions spoken in it.

Direx then checks each moment in code. A moment is kept only if it:

- lies inside the video and lasts 20 to 90 seconds,
- backs a current Fact or names a measure in the plan,
- cites only Facts that exist and haven't changed since that version,
- doesn't overlap a moment already kept.

At most 8 clips come from one recording. Moments that fail are listed under "Moments left out",
each with its reason. Each clip is cut vertical, with captions burned in that follow the words as
spoken, and starts and ends on a word, never in the middle of one.

## Where the clips go

Each clip goes to one account. An account posts at most one clip a day, for a week from the first
post. Accounts on the same network go out half an hour apart. If there are more clips than fit, the
step says how many aren't posted. If there are more accounts than clips, some get none.

You can add another recording to the same step later. Its posts skip the days an account already
posts a clip from this step.

## Approving and posting

Each clip shows its video, why it was picked, and a post for its account in Needs approval.

- **Approve this clip** approves that clip's posts that have no warnings.
- **Caption** lets you change the post text. "Save caption" drafts that post again, which needs a
  new approval.

An approved post on a connected account is scheduled and goes out at its time. For a network Direx
can't post to, you post it yourself: once approved, copy the text, download the video and post it
by hand.

If a Fact a clip cites changes after the post was drafted, a post you'll make by hand that is still
waiting for approval gets a warning to read it again first.
