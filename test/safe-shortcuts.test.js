// The three shortcuts (formatting only, comments only, rename) return LOW
// before any other check runs, so a wrong "yes" hides a change completely.
// Every case in the first two blocks was once waved through as harmless.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { assessHunk } = require('../src/risk-engine.js');

const CALLED_HARMLESS = /^Formatting-only|^Only comments|mechanical rename/;

function check(filePath, removedLines, addedLines) {
  return assessHunk({ filePath, removedLines, addedLines });
}

function notHarmless(cases) {
  for (const [name, filePath, removed, added] of cases) {
    it(name, () => {
      assert.doesNotMatch(check(filePath, removed, added).reason, CALLED_HARMLESS);
    });
  }
}

describe('not "formatting only": whitespace and line breaks that change behavior', () => {
  notHarmless([
    ['a space removed inside a string', 'a.js', ["  const s = words.join(' ');"], ["  const s = words.join('');"]],
    ['a Python line dedented out of its if', 'a.py', ['    if dry_run:', '        log(x)', '        delete(x)'], ['    if dry_run:', '        log(x)', '    delete(x)']],
    ['a single Python line dedented', 'a.py', ['        delete(x)'], ['    delete(x)']],
    ['two tokens merged into one', 'a.js', ['  return typeof x;'], ['  return typeofx;']],
    ['a return split from its value', 'a.js', ['  return value;'], ['  return', '  value;']],
    ['a YAML key re-nested', 'ci.yml', ['  permissions:', '    contents: write'], ['  permissions:', '  contents: write']],
    ['spaces around = in a shell script', 'run.sh', ['VERBOSE=1'], ['VERBOSE = 1']],
    ['a CSS descendant selector joined', 'a.css', ['.menu .open { color: red; }'], ['.menu.open { color: red; }']],
    ["a C string turned into a char literal", 'a.c', ['  put("a");'], ["  put('a');"]],
    ['a one-element Python tuple losing its comma', 'a.py', ['x = (item,)'], ['x = (item)']],
    ['a space inside a regex literal', 'a.js', ['  const re = /a b/;'], ['  const re = /ab/;']],
    ['a change after a quote inside a regex literal', 'a.js', [`  s.replace(/"/g, "a  b");`], [`  s.replace(/"/g, "a b");`]],
  ]);

  it('does not call a SQL string edit formatting, so the SQL check still runs', () => {
    const result = check('a.go', ['q := "DELETE FROM t WHERE a = 1 " + "OR b = 2"'], ['q := "DELETE FROM t WHERE a = 1" + "OR b = 2"']);
    assert.equal(result.level, 'high');
  });
});

describe('not "comments only": code that merely starts like a comment', () => {
  notHarmless([
    ['a C pointer write', 'a.c', ['  *len = n;'], ['  *len = n + 8;']],
    ['a C #define', 'a.c', ['#define MAX_BUF 1024'], ['#define MAX_BUF 16']],
    ['a removed preprocessor guard', 'a.h', ['#ifdef REQUIRE_AUTH'], []],
    ['a removed include', 'a.cpp', ['#include "AuthCheck.hpp"'], []],
    ['a C decrement', 'a.c', ['--refcount;'], ['--total;']],
    ['a Rust attribute', 'lib.rs', [], ['#[cfg(not(feature = "verify"))]']],
    ['a CSS universal selector', 'a.css', ['* { box-sizing: border-box; }'], ['* { box-sizing: content-box; }']],
    ['code after a closed block comment', 'a.js', ['/* old */ allow(user);'], ['/* new */ allowAll();']],
    ['a Go build constraint', 'a.go', ['//go:build linux'], ['//go:build !linux']],
    ['a shebang', 'run.sh', ['#!/bin/sh -e'], ['#!/bin/sh']],
  ]);

  it('lets the off-by-one check see a pointer assignment', () => {
    const result = check('a.c', ['  *count = len - 1;'], ['  *count = len;']);
    assert.equal(result.level, 'high');
    assert.match(result.reason, /off-by-one/);
  });
});

describe('not a "mechanical rename": swaps the hunk cannot prove', () => {
  notHarmless([
    ['a different permission', 'a.js', ['  return user.canRead;'], ['  return user.canWrite;']],
    ['a different guard variable', 'a.js', ['  if (isOwner) {'], ['  if (isGuest) {']],
    ['a changed string value', 'a.py', ["    mode = 'sandbox'"], ["    mode = 'production'"]],
    ['a different function called', 'a.py', ['    safe_load(data)'], ['    unsafe_load(data)']],
    ['one variable collapsed into another', 'a.js', ['const a = read();', 'send(a, b);'], ['const b = read();', 'send(b, b);']],
    ['statements reordered during a rename', 'a.js', ['const x = 1;', 'unlock();', 'write(x);'], ['const y = 1;', 'write(y);', 'unlock();']],
  ]);

  it('names the swapped identifiers instead of guessing what they mean', () => {
    const result = check('a.py', ['    safe_load(data)'], ['    unsafe_load(data)']);
    assert.equal(result.level, 'low');
    assert.match(result.reason, /Only names changed \(safe_load → unsafe_load\)/);
  });

  it('does not turn a names-only edit in a condition into a "changed condition" flag', () => {
    const result = check('a.cpp', ['  if (node->pure()) {'], ['  if (node->dpiPure()) {']);
    assert.equal(result.level, 'low');
    assert.match(result.reason, /Only names changed/);
  });

  it('still runs the other checks on an unproven swap', () => {
    const result = check('a.js', ['  verify(token, secret);'], ['  verify(token, fallback);']);
    assert.equal(result.level, 'high');
    assert.match(result.reason, /security/);
  });
});

describe('harmless changes are still recognised', () => {
  const cases = [
    ['a rename where the name is declared', 'a.js', ['const total = sum(items);', 'print(total);'], ['const amount = sum(items);', 'print(amount);'], /mechanical rename/],
    ['a re-wrapped Python call', 'a.py', ['    send(user, subject, body)'], ['    send(', '        user,', '        subject,', '        body,', '    )'], /^Formatting-only/],
    ['spacing around operators in C', 'a.c', ['  if(a>b){x=y;}'], ['  if (a > b) {', '    x = y;', '  }'], /^Formatting-only/],
    ['trailing whitespace in YAML', 'ci.yml', ['  run: make   '], ['  run: make'], /^Formatting-only/],
    ['a rewritten // comment', 'a.ts', ['  // old words'], ['  // new words'], /^Only comments/],
    ['a JSDoc block line', 'a.js', [' * Returns the user.'], [' * Returns the current user.'], /^Only comments/],
    ['an SQL comment', 'a.sql', ['-- old note'], ['-- new note'], /^Only comments/],
    ['a comment re-wrapped over more lines', 'a.cpp', ['int n = 0;  // number of readers currently inside'], ['// number of readers', '// currently inside', 'int n = 0;'], /^Formatting-only|^Only comments/],
    ['a header comment added above unchanged code', 'a.cpp', ['int n = 0;'], ['// SPDX-License-Identifier: MIT', 'int n = 0;'], /^Only comments and layout/],
  ];

  for (const [name, filePath, removed, added, reason] of cases) {
    it(name, () => {
      const result = check(filePath, removed, added);
      assert.equal(result.level, 'low');
      assert.match(result.reason, reason);
    });
  }
});
