const { renderMarkdown, extractExcerpt } = require('./render');

describe('render', () => {
  describe('renderMarkdown', () => {
    it('renders a heading into an h1', async () => {
      const html = await renderMarkdown('# Hello');
      expect(html).toContain('<h1');
      expect(html).toContain('Hello');
    });

    it('renders bold and italic', async () => {
      const html = await renderMarkdown('**bold** and *italic*');
      expect(html).toContain('<strong>bold</strong>');
      expect(html).toContain('<em>italic</em>');
    });

    it('renders a code fence as pre/code without syntax highlighting classes', async () => {
      const html = await renderMarkdown('```js\nconsole.log(1)\n```');
      expect(html).toContain('<pre>');
      expect(html).toContain('<code>');
      expect(html).toContain('console.log(1)');
      // no highlight.js-style class on the code element
      expect(html).not.toMatch(/class=["']hljs/);
    });

    it('renders a paragraph', async () => {
      const html = await renderMarkdown('Just text.');
      expect(html).toContain('<p>');
      expect(html).toContain('Just text.');
    });

    it('keeps markdown unchanged when empty', async () => {
      expect(await renderMarkdown('')).toBe('');
      expect(await renderMarkdown('   ')).toBe('');
    });

    it('renders a link', async () => {
      const html = await renderMarkdown('[example](https://example.com)');
      expect(html).toContain('<a');
      expect(html).toContain('https://example.com');
    });

    it('does not add syntax highlighting to inline code', async () => {
      const html = await renderMarkdown('use `foo()` here');
      expect(html).toContain('foo()');
      expect(html).not.toMatch(/class=["']hljs/);
    });
  });

  describe('extractExcerpt', () => {
    it('returns the first paragraph of rendered HTML as plain text', () => {
      const html = '<h1>Title</h1>\n<p>This is the first paragraph.</p>\n<p>Second.</p>';
      expect(extractExcerpt(html)).toBe('This is the first paragraph.');
    });

    it('strips the leading heading from the first paragraph', () => {
      const html = '<h1>Title</h1>\n<p>First paragraph here.</p>';
      expect(extractExcerpt(html)).toBe('First paragraph here.');
    });

    it('returns empty string for empty html', () => {
      expect(extractExcerpt('')).toBe('');
      expect(extractExcerpt('   ')).toBe('');
    });

    it('truncates long excerpts to 200 characters at a word boundary', () => {
      const long = '<p>' + 'word '.repeat(50) + '</p>';
      const ex = extractExcerpt(long);
      expect(ex.length).toBeLessThanOrEqual(201);
      expect(ex).not.toMatch(/\s\S$/);
      expect(ex).toMatch(/\s/);
    });

    it('append ellipsis when truncated', () => {
      const long = '<p>' + ('abcdefghij ').repeat(20) + '</p>';
      const ex = extractExcerpt(long);
      expect(ex.length).toBeLessThanOrEqual(201);
      if (ex.length === 201) {
        expect(ex).toEndWith('…');
      }
    });

    it('returns the first paragraph even when there are multiple', () => {
      const html = '<h2>Sub</h2>\n<p>Only this matters.</p>\n<p>Ignored.</p>';
      expect(extractExcerpt(html)).toBe('Only this matters.');
    });
  });
});


// ensure expect has toEndWith (added below)
