# Knowledge Bits

> **From trusted sources to approved knowledge, delivered.**

Knowledge Bits is a standalone, evidence-backed content operations engine. It turns a brief and a set of trustworthy resources into a reviewed, traceable, multi-format `KnowledgeBits` package and delivers that package to the systems where an audience consumes it.

Sources may be collected from Chrome, Deep Research, customer documents, NotebookLM, or other provider adapters. Knowledge Bits owns the workflow, evidence, quality gates, package identity, human approval, and delivery state.

**Status:** Implementation planning  
**Initial consumer:** Nuglet

## Workflow

```text
Research
→ Create
→ Check
→ Produce assets
→ Human review
→ Deliver
```

A completed package can contain:

- approved content;
- accepted source evidence and claim-to-citation mappings;
- deterministic and editorial quality reports;
- hero, infographic, audio, and other required assets;
- provenance and usage-rights metadata;
- an immutable checksum binding approval to the exact revision;
- a destination-specific delivery payload.

## Product model

Knowledge Bits is designed as an open, self-hostable evidence engine with a commercial managed service and hosted cloud layer.

The intended business model combines:

- a productized managed service for early customers;
- subscriptions for hosted production capacity;
- usage based on approved and delivered packages;
- premium integrations and domain policy packs;
- enterprise private deployments, controls, support, and SLAs;
- a self-hostable community engine and open package specification.

Knowledge Bits is not a generic newsletter generator, prompt collection, or NotebookLM wrapper. It is the reliable production layer between trusted source material and publishing, learning, newsletter, or customer-education destinations.

## V1

V1 is intentionally narrow: one independently deployed engine, one local worker, one human approval, and Nuglet as the only consumer. It uses strict isolation, immutable artifacts, provider-neutral adapters, deterministic workflow state, and idempotent delivery.

Public accounts, billing, multi-tenancy, additional consumer integrations, high-stakes domain packs, and a package marketplace are deferred until the core pipeline is proven.

## Documentation

- [Product and business vision](docs/VISION.md)
- [Approved V1 design](docs/V1_DESIGN.md)
