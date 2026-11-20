import { describe, expect, it } from 'vitest';
import {
  normalizeDomain,
  parseFlexibleDate,
  parseTrafficNumber,
} from '../services/scanner/domainUtils.js';

describe('domainUtils', () => {
  it('normalizes URLs and domains to canonical registrable domain', () => {
    expect(normalizeDomain('https://www.TheVerge.com/2026/11/tech-story')).toBe('theverge.com');
    expect(normalizeDomain('m.bbc.co.uk/news')).toBe('bbc.co.uk');
    expect(normalizeDomain('blog.example.org:8080/feed')).toBe('example.org');
    expect(normalizeDomain('  SubDomain.MySite.com.au/about  ')).toBe('mysite.com.au');
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('127.0.0.1')).toBeNull();
    expect(normalizeDomain('not a domain')).toBeNull();
  });

  it('parses shorthand and formatted monthly visitor counts', () => {
    expect(parseTrafficNumber('1.2M')).toBe(1_200_000);
    expect(parseTrafficNumber('450.5K')).toBe(450_500);
    expect(parseTrafficNumber('85,000')).toBe(85_000);
    expect(parseTrafficNumber('2.1B')).toBe(2_100_000_000);
    expect(parseTrafficNumber('120000')).toBe(120_000);
    expect(parseTrafficNumber('')).toBeNull();
    expect(parseTrafficNumber('N/A')).toBeNull();
  });

  it('parses ISO, US slash, Date objects, and Excel serial dates', () => {
    expect(parseFlexibleDate('2026-11-15')).toBe('2026-11-15');
    expect(parseFlexibleDate('11/15/2026')).toBe('2026-11-15');
    expect(parseFlexibleDate('2026/05/03')).toBe('2026-05-03');
    expect(parseFlexibleDate(new Date('2026-08-19T12:00:00Z'))).toBe('2026-08-19');
    // Excel serial 46023 = 2026-01-01
    expect(parseFlexibleDate(46023)).toBe('2026-01-01');
    expect(parseFlexibleDate('not-a-date')).toBeNull();
  });
});
