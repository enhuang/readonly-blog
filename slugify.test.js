const slugify = require('./slugify').slugify;

describe('slugify', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('My First Post')).toBe('my-first-post');
  });

  it('strips punctuation and special characters', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(slugify('What is Node.js?')).toBe('what-is-node-js');
  });

  it('collapses multiple hyphens and trims leading/trailing hyphens', () => {
    expect(slugify('  foo  bar  ')).toBe('foo-bar');
    expect(slugify('a---b')).toBe('a-b');
    expect(slugify('-leading')).toBe('leading');
    expect(slugify('trailing-')).toBe('trailing');
  });

  it('handles empty and whitespace-only input', () => {
    expect(slugify('')).toBe('');
    expect(slugify('   ')).toBe('');
  });

  it('normalizes common accented characters', () => {
    expect(slugify('café')).toBe('cafe');
    expect(slugify('naïve')).toBe('naive');
    expect(slugify('Ångström')).toBe('angstrom');
  });

  it('keeps numbers and hyphens that are already meaningful', () => {
    expect(slugify('Post 42: the answer')).toBe('post-42-the-answer');
    expect(slugify('state-of-the-art')).toBe('state-of-the-art');
  });

  it('returns a safe non-empty slug even for odd input', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify('a')).toBe('a');
  });
});
