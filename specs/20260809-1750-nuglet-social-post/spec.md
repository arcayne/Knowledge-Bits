# Canonical Nuglet social post

## Objective

Add one lesson-grounded, cross-platform social media post to every new Story/Playbook Nuglet. The post must live in the canonical Nuglet payload, include literal hashtag tokens, survive review/package delivery, and be explicitly bound to the public-preview/social workflow.

## Non-goals

- No platform-specific variants for Instagram, TikTok, LinkedIn, or X in this change.
- No automatic publishing or posting to social networks.
- No regeneration of hero, infographic, audio, or an already-approved video solely because the field is added.
- No generic productivity copy detached from the lesson.

## Proposed contract

Add a required `socialPost` object to the Story/Playbook payload:

```json
{
  "socialPost": {
    "platform": "cross-platform",
    "text": "Lesson-grounded post copy.\n\n#Attention #Focus #Productivity"
  }
}
```

The generated video is its companion asset, not an unrelated media item. The
review/package representation should expose the relationship explicitly:

```json
{
  "content": {
    "target": {
      "payload": {
        "socialPost": {
          "platform": "cross-platform",
          "text": "... #Attention #Focus #Productivity"
        }
      }
    }
  },
  "assets": {
    "publicPreview": {
      "artifactId": "...",
      "companion": {
        "contentChecksum": "sha256:...",
        "socialPostChecksum": "sha256:..."
      }
    }
  }
}
```

The exact post text is stored once in the Nuglet payload. The video companion
stores checksummed references to the content revision and social-post text,
along with the existing run/revision/package identity. This prevents the
caption from drifting away from the video while avoiding a second mutable copy
of the post inside media metadata.

Contract rules:

- `platform` is the literal `cross-platform`.
- `text` is concise, lesson-specific, and contains at least three literal hashtags.
- Hashtags use `#` followed by a Unicode letter or number sequence; no spaces inside a tag.
- The copy may not assert facts outside the Nuglet's approved claims.
- The social post is learner-facing copy, not provider instructions or a video transcript.

## Pipeline behavior

- The Story/Playbook create prompt requests and explains `socialPost`.
- Deterministic checks validate hashtag syntax and preserve claim grounding.
- Review packages and delivered `nuglet.lesson.v1` payloads include the field.
- Review UI exposes the post as copyable content alongside the lesson/video preview.
- Public-preview generation receives the canonical post as context but remains responsible only for the video artifact.
- The public-preview artifact is rejected unless its companion checksums bind it to the exact canonical content and social post used for generation.
- Existing legacy payloads remain readable during migration; new content with a social post is required before a package can pass the new social-content gate.

## Existing Protect Your Attention

Create a new content revision containing a grounded social post for the already-approved lesson, invalidate the current approval for that revision, and require human review again. Do not alter the historical delivered package or auto-publish the revised package.

## Acceptance criteria

- A new Story/Playbook draft with a valid social post passes contracts and deterministic checks.
- A missing post, missing `#`, malformed hashtag, or fewer than three hashtags is rejected with an actionable finding.
- The review package exposes the exact post text and hashtags.
- The review package exposes the explicit `socialPost` ↔ `publicPreview` companion relationship and rejects mismatched checksums.
- Delivery preserves the same post in the Nuglet payload.
- The public-preview prompt can reference the exact canonical social post without inventing a different caption.
- Existing legacy lessons without the field remain readable until explicitly revised.

## Verification plan

- Contract tests for valid and invalid social posts.
- NotebookLM prompt/output tests for generation and semantic repair.
- Deterministic-check tests for hashtag and grounding rules.
- Review-package/materializer tests for preservation.
- Review UI test for display/copy behavior.
- Focused worker/API test suite and `git diff --check`.

## Decision and migration boundary

The approved model is one cross-platform post per Nuglet. New Story/Playbook
content is gated on that field while already-delivered legacy content remains
readable. Protect Your Attention requires a separate safe strict-content
revision before it can be backfilled; this implementation does not mutate its
historical approved package or trigger provider work.
