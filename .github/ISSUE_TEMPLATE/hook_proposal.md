---
name: Hook proposal
about: Propose a new hook for the standard library or the marketplace.
labels: hook
---

## Hook name

A short PascalCase identifier (`MyCustomHook`).

## Lifecycle bits

Which of the eight lifecycle events does it fire on?

## Decision shape

Does it return `Accept`, `AcceptWith(side_effect)`, or `Reject(reason)`? Which side effects does it emit?

## State

Does it read from a PDA? An oracle? A registered provider program?

## Use case

What pool operator wants this and why.
