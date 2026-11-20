import * as cheerio from 'cheerio';

export interface AudioDetectionResult {
  hasAudioPlayer: boolean;
  providersDetected: string[];
  evidence: string | null;
}

interface AudioSignature {
  name: string;
  patterns: RegExp[];
}

const AUDIO_SIGNATURES: AudioSignature[] = [
  {
    name: 'BeyondWords',
    patterns: [
      /beyondwords\.io/i,
      /speechkit\.io/i,
      /beyondwords-player/i,
      /BeyondWords\.Player/i,
      /data-beyondwords/i,
    ],
  },
  {
    name: 'Trinity Audio',
    patterns: [
      /trinitymedia\.ai/i,
      /trinity-audio/i,
      /trinityplayer/i,
      /class=["'][^"']*trinity/i,
    ],
  },
  {
    name: 'Instaread',
    patterns: [/instaread\.co/i, /instaread-player/i, /<instaread-player/i],
  },
  {
    name: 'Speechify',
    patterns: [/speechify\.com\/.*widget/i, /speechify-player/i, /speechify-audio/i],
  },
  {
    name: 'ElevenLabs AudioNative',
    patterns: [/elevenlabs\.io\/player/i, /elevenlabs-audionative/i, /data-elevenlabs/i],
  },
  {
    name: 'PlayHT',
    patterns: [/play\.ht\/.*embed/i, /playht-player/i, /data-playht/i],
  },
  {
    name: 'Amazon Polly',
    patterns: [/amazon-polly/i, /wp-polly/i, /polly-audio-player/i],
  },
  {
    name: 'WebsiteVoice',
    patterns: [/websitevoice\.com/i, /wv-widget/i],
  },
  {
    name: 'ReadSpeaker',
    patterns: [/readspeaker\.com/i, /f1\.readspeaker/i, /rs_read_this/i],
  },
  {
    name: 'ReciteMe',
    patterns: [/reciteme\.com/i],
  },
  {
    name: 'Listen2It',
    patterns: [/listen2it\.com/i, /l2i-player/i],
  },
  {
    name: 'ResponsiveVoice',
    patterns: [/responsivevoice\.org/i],
  },
  {
    name: 'GSpeech',
    patterns: [/gspeech/i, /gtranslate.*gspeech/i],
  },
  {
    name: 'Blogcast',
    patterns: [/blogcast\.host/i],
  },
  {
    name: 'SpokenLayer',
    patterns: [/spokenlayer\.com/i],
  },
  {
    name: 'Curio',
    patterns: [/curio\.io\/.*embed/i, /curio-audio-player/i],
  },
];

const ARTICLE_AUDIO_PHRASES =
  /\b(listen to this article|listen to article|audio version of this article|play article|read this article aloud|article audio player)\b/i;

export function detectAudioPlayersFromHtml(htmlDocs: Array<{ url: string; html: string; isArticle?: boolean }>): AudioDetectionResult {
  const detected = new Set<string>();
  const evidenceParts: string[] = [];

  for (const doc of htmlDocs) {
    if (!doc.html) continue;

    for (const sig of AUDIO_SIGNATURES) {
      if (sig.patterns.some((rx) => rx.test(doc.html))) {
        if (!detected.has(sig.name)) {
          detected.add(sig.name);
          evidenceParts.push(`${sig.name} matched in ${doc.isArticle ? 'article' : 'homepage'}`);
        }
      }
    }

    const $ = cheerio.load(doc.html);

    // Check script src & iframe src explicitly for clean matches
    $('script[src], iframe[src]').each((_, el) => {
      const src = $(el).attr('src') || '';
      for (const sig of AUDIO_SIGNATURES) {
        if (sig.patterns.some((rx) => rx.test(src))) {
          if (!detected.has(sig.name)) {
            detected.add(sig.name);
            evidenceParts.push(`${sig.name} script/iframe (${src.slice(0, 80)})`);
          }
        }
      }
    });

    // Check native <audio> inside <article> or main article body, or explicit read-aloud UI controls
    if (doc.isArticle) {
      const articleContainer = $('article').first().length ? $('article').first() : $('main').first();
      if (articleContainer.length > 0) {
        const audioTags = articleContainer.find('audio, [data-audio-player], .audio-player');
        if (audioTags.length > 0) {
          // Ensure it's not an unrelated podcast embed labeled "podcast" without read-aloud hints
          const contextText = articleContainer.text().slice(0, 2000).toLowerCase();
          if (
            ARTICLE_AUDIO_PHRASES.test(contextText) ||
            articleContainer.find('audio').length > 0
          ) {
            if (!detected.has('Native Article Audio')) {
              detected.add('Native Article Audio');
              evidenceParts.push(`<audio> / audio-player element inside article (${doc.url})`);
            }
          }
        }
      }

      const headerRegion = $('article header, main header, .article-header, .post-header, article')
        .first()
        .text()
        .slice(0, 1200);
      const phraseMatch = ARTICLE_AUDIO_PHRASES.exec(headerRegion);
      if (phraseMatch && !detected.has('Article Read-Aloud Control')) {
        detected.add('Article Read-Aloud Control');
        evidenceParts.push(`Phrase "${phraseMatch[0]}" near article header`);
      }
    }
  }

  return {
    hasAudioPlayer: detected.size > 0,
    providersDetected: Array.from(detected),
    evidence: evidenceParts.length > 0 ? evidenceParts.join('; ') : null,
  };
}
