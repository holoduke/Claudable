import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthorAvatar, authorInitials, authorLabel, authorOf } from './MessageAuthor';

describe('message author', () => {
  it('reads the author from metadata, or nothing for old messages', () => {
    expect(authorOf({ metadata: { author: { id: 'u1', name: 'Thana Bos', email: 'thana@newstory.nl', image: null } } })?.name).toBe('Thana Bos');
    expect(authorOf({ metadata: { attachments: [] } })).toBeNull();
    expect(authorOf({ metadata: null })).toBeNull();
    expect(authorOf({ metadata: { author: { id: 'x', name: '', email: '' } } })).toBeNull();
  });
  it('labels with the name, else the e-mail local part', () => {
    expect(authorLabel({ name: 'Frido van Dijk', email: 'frido@newstory.nl' })).toBe('Frido van Dijk');
    expect(authorLabel({ name: null, email: 'silvan@newstory.nl' })).toBe('silvan');
    expect(authorInitials({ name: 'Frido van Dijk' })).toBe('FV');
    expect(authorInitials({ email: 'silvan@newstory.nl' })).toBe('S');
  });
  it('renders the photo (no referrer) or initials', () => {
    const photo = renderToStaticMarkup(<AuthorAvatar author={{ name: 'Thana Bos', email: 't@x', image: 'https://lh3.googleusercontent.com/a/x' }} />);
    expect(photo).toMatch(/<img[^>]+src="https:\/\/lh3\.googleusercontent\.com\/a\/x"/);
    expect(photo).toMatch(/referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/i);
    const initials = renderToStaticMarkup(<AuthorAvatar author={{ name: 'Thana Bos', email: 't@x', image: null }} />);
    expect(initials).toContain('>TB<');
    expect(initials).toContain('title="Thana Bos"');
  });
});
