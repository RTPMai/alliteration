//
// One round is: somebody was shown a design, guessed the stitch count, and
// optionally said what kind of design it was. The server scores the guess
// against the TRUE count from the DST, and scores the model against the same
// truth at the same moment, so the two are always compared on identical
// questions.
//
// WHY THE SERVER SCORES AND NOT THE CLIENT
// The client is not told the answer until it has posted the guess. If the
// browser held the true count in order to score locally, the answer would be
// sitting in the page for anyone who opened dev tools, and a leaderboard that
// can be cheated in ten seconds is not a leaderboard. So: the design record
// the game fetches carries the picture and the dimensions, the POST comes
// back, and the truth is in the RESPONSE to that POST.
//
// WHAT THE GAME ACTUALLY TEACHES THE MODEL
// Not the guesses. A human guess is not ground truth and can never be a
// training label. Two other things:
//
//   1. The character tag. Whether a design is text, a fill, line art or puff
//      is exactly the feature that failed validation when it was scraped out
//      of filenames. A digitiser picking it from a list is a real label.
//   2. Whether people beat the model, and where. If the shop is consistently
//      better than the tool on, say, applique, the tool is missing something
//      a person can see, and that is worth knowing before anybody trusts it.
//
// GET              -> stats: leaderboard, human vs model, tag coverage
// GET ?mine=1      -> the caller's own recent rounds
// POST             -> submit a guess, get the truth and the score back
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from '../../lib/session.js';
import { validateRound, CHARACTER_KEYS } from '../../lib/stitchsense/schema.js';
import { estimate, scoreGuess, MODEL_VERSION } from '../../lib/stitchsense/model.js';
import { listRounds, saveRound, nextRoundId, getDesign, updateDesign } from '../../lib/stitchsense/store.js';

function parseBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === 'object' ? b : {};
}

function median(nums) {
  if (!nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Roll rounds up into the numbers the board shows.
 *
 * The human-versus-model comparison uses ONLY rounds where both scored, and
 * compares them on the same designs. Comparing every human round against the
 * model's average over the whole archive would be flattering to whichever side
 * happened to draw the easier designs.
 */
function summarise(rounds) {
  const byPlayer = new Map();
  const humanErrors = [];
  const modelErrors = [];
  const tagCounts = {};

  for (const r of rounds) {
    const who = r.username || 'unknown';
    if (!byPlayer.has(who)) {
      byPlayer.set(who, { username: who, rounds: 0, points: 0, errors: [], bullseyes: 0 });
    }
    const p = byPlayer.get(who);
    p.rounds++;
    p.points += Number(r.points || 0);
    if (r.errorPct != null) p.errors.push(r.errorPct);
    if (r.band === 'bullseye') p.bullseyes++;

    if (r.errorPct != null && r.modelErrorPct != null) {
      humanErrors.push(r.errorPct);
      modelErrors.push(r.modelErrorPct);
    }
    if (r.character) tagCounts[r.character] = (tagCounts[r.character] || 0) + 1;
  }

  const leaderboard = Array.from(byPlayer.values())
    .map((p) => ({
      username: p.username,
      rounds: p.rounds,
      points: p.points,
      bullseyes: p.bullseyes,
      medianErrorPct: median(p.errors),
      // Average points per round, not total. Otherwise the leaderboard just
      // ranks whoever played the most, which rewards the wrong thing.
      avgPoints: p.rounds ? Math.round(p.points / p.rounds) : 0
    }))
    .sort((a, b) => b.avgPoints - a.avgPoints);

  const headToHead = humanErrors.length
    ? {
        rounds: humanErrors.length,
        humanMedianErrorPct: median(humanErrors),
        modelMedianErrorPct: median(modelErrors),
        humanWithin20: humanErrors.filter((e) => e <= 0.2).length / humanErrors.length,
        modelWithin20: modelErrors.filter((e) => e <= 0.2).length / modelErrors.length,
        humanWins: humanErrors.filter((e, i) => e < modelErrors[i]).length
      }
    : null;

  // How close the tagging effort is to being usable. Segment factors need a
  // few hundred labels per character before they can be tested honestly, and
  // saying so on screen is more useful than a bare count.
  const tagged = Object.values(tagCounts).reduce((a, b) => a + b, 0);
  const coverage = CHARACTER_KEYS.map((k) => ({ character: k, count: tagCounts[k] || 0 }));

  return { leaderboard, headToHead, tagCoverage: coverage, taggedRounds: tagged, totalRounds: rounds.length };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  const me = String(sess.username || '').toLowerCase();
  const q = req.query || {};

  try {
    if (req.method === 'GET') {
      const rounds = await listRounds();
      if (q.mine) {
        const mine = rounds
          .filter((r) => r.username === me)
          .slice(-50)
          .reverse();
        return res.status(200).json({ rounds: mine });
      }
      return res.status(200).json(summarise(rounds));
    }

    if (req.method === 'POST') {
      const { ok, errors, record } = validateRound(parseBody(req));
      if (!ok) return res.status(400).json({ error: errors.join('; '), errors });

      const design = await getDesign(record.designId);
      if (!design) return res.status(404).json({ error: 'Design not found' });

      const truth = Number(design.stitches || 0);
      const human = scoreGuess(record.guess, truth);

      // The model answers the same question, from the same measurements, at
      // the same moment. Stored per round rather than recomputed later so a
      // future recalibration cannot rewrite history and make the model look
      // like it was always winning.
      const modelSaid = estimate({ coveredSqIn: design.coveredSqIn, colors: design.colors });
      const model = scoreGuess(modelSaid.likely, truth);

      const round = {
        id: await nextRoundId(),
        ...record,
        username: me,
        actualStitches: truth,
        errorPct: human.errorPct,
        points: human.points,
        band: human.band,
        modelGuess: modelSaid.likely,
        modelErrorPct: model.errorPct,
        modelVersion: MODEL_VERSION,
        createdAt: new Date().toISOString()
      };

      await saveRound(round);

      // Tally the character vote onto the design itself, so the library can
      // show what a design is without re-reading every round.
      if (record.character) {
        const votes = { ...(design.characterVotes || {}) };
        votes[record.character] = (Number(votes[record.character]) || 0) + 1;
        await updateDesign(design.id, { characterVotes: votes });
      }

      return res.status(200).json({
        round,
        // The reveal. First time the client learns the answer.
        actualStitches: truth,
        errorPct: human.errorPct,
        points: human.points,
        band: human.band,
        model: { guess: modelSaid.likely, low: modelSaid.low, worst: modelSaid.worst, errorPct: model.errorPct },
        beatTheModel: human.errorPct != null && model.errorPct != null && human.errorPct < model.errorPct
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
}
