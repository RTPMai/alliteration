// lib/concontrol/foc26-survey.js — the FOC26 audience survey, as data.
//
// WHY THIS IS IN THE REPO. The seeder shipped first as a route that needed its
// payload pasted into a browser console, which meant the deploy landed and
// nothing happened, which is a worse outcome than not shipping it. A one-time
// import nobody can run is not an import. The data is small, historical and
// finished, so it lives here and Settings has a button.
//
// NO PERSONAL DATA. Only the two answers the tally reads: the five topics each
// shop picked and the one session they named as unmissable. No names, no email
// addresses, no free text. Nineteen responses, collected Aug 26 to Sep 10 2026.
//
// The wishlist below is names of people in the industry that respondents asked
// to hear from, which is a business contact list, not survey responses.
//
// ESM. Do NOT convert to module.exports.

export const FOC26_RESPONSES = [
  {
    "topics": "The seasonal cash crunch | Short runs without losing money | AI doing actual shop work, live | Marketing your shop without an agency | Burnout and the isolation of running a shop",
    "must_have_session": "AI doing actual shop work, live"
  },
  {
    "topics": "Reading your own P&L and balance sheet | Embroidery: digitizing, stabilizer and hooping | Hiring, training and keeping good people | What you pay your people, with real numbers from the room | Burnout and the isolation of running a shop",
    "must_have_session": "Hiring, training and keeping good people"
  },
  {
    "topics": "What a job actually costs, down to the garment | Raising prices without losing the customer | Finding the bottleneck on your own floor | Hiring, training and keeping good people | Succession: what happens to your shop when you stop",
    "must_have_session": "Finding the bottleneck on your own floor"
  },
  {
    "topics": "Short runs without losing money | AI doing actual shop work, live | Embroidery: digitizing, stabilizer and hooping | Burnout and the isolation of running a shop",
    "must_have_session": "AI doing actual shop work, live"
  },
  {
    "topics": "Raising prices without losing the customer | Production ready artwork and separations | Company stores, fundraising and program work | Live printing activations and events | The art your customer sent you is illegal: trademark, licensing and AI art",
    "must_have_session": "Production ready artwork and separations"
  },
  {
    "topics": "Raising prices without losing the customer | Short runs without losing money | What a job actually costs, down to the garment | Embroidery: digitizing, stabilizer and hooping | AI doing actual shop work, live",
    "must_have_session": "Raising prices without losing the customer"
  },
  {
    "topics": "Short runs without losing money | The seasonal cash crunch | Reading your own P&L and balance sheet | Buying used equipment without getting burned | Live printing activations and events",
    "must_have_session": "The seasonal cash crunch"
  },
  {
    "topics": "Reading your own P&L and balance sheet | The seasonal cash crunch | Combining decoration methods on one garment | AI doing actual shop work, live | Hiring, training and keeping good people",
    "must_have_session": "Hiring, training and keeping good people"
  },
  {
    "topics": "Raising prices without losing the customer | Short runs without losing money | AI doing actual shop work, live | Marketing your shop without an agency | Succession: what happens to your shop when you stop",
    "must_have_session": "Raising prices without losing the customer"
  },
  {
    "topics": "Raising prices without losing the customer | What a job actually costs, down to the garment | Finding the bottleneck on your own floor | Where is that job right now: production tracking and shop software | Screen making, exposure and registration",
    "must_have_session": "Finding the bottleneck on your own floor"
  },
  {
    "topics": "Spoilage: real numbers from real shops | Embroidery: digitizing, stabilizer and hooping | Combining decoration methods on one garment | Hiring, training and keeping good people | What you pay your people, with real numbers from the room",
    "must_have_session": "Embroidery: digitizing, stabilizer and hooping"
  },
  {
    "topics": "Short runs without losing money | Spoilage: real numbers from real shops | Finding the bottleneck on your own floor | AI doing actual shop work, live | Burnout and the isolation of running a shop",
    "must_have_session": "Finding the bottleneck on your own floor"
  },
  {
    "topics": "Screen making, exposure and registration | Preventive maintenance and the repairs you can do yourself | Hiring, training and keeping good people | Webstores built live, start to finish | Chemicals, ventilation, fire and OSHA",
    "must_have_session": "Hiring, training and keeping good people"
  },
  {
    "topics": "The seasonal cash crunch | Embroidery: digitizing, stabilizer and hooping | Finding the bottleneck on your own floor | Hiring, training and keeping good people | The art your customer sent you is illegal: trademark, licensing and AI art",
    "must_have_session": "The art your customer sent you is illegal: trademark, licensing and AI art"
  },
  {
    "topics": "The seasonal cash crunch | Raising prices without losing the customer | Embroidery: digitizing, stabilizer and hooping | Where is that job right now: production tracking and shop software | Burnout and the isolation of running a shop",
    "must_have_session": "Where is that job right now: production tracking and shop software"
  },
  {
    "topics": "The seasonal cash crunch | AI doing actual shop work, live | Where is that job right now: production tracking and shop software | Selling more than a shirt | Company stores, fundraising and program work",
    "must_have_session": "The seasonal cash crunch"
  },
  {
    "topics": "Buying used equipment without getting burned | Embroidery: digitizing, stabilizer and hooping | Preventive maintenance and the repairs you can do yourself | Combining decoration methods on one garment | Burnout and the isolation of running a shop",
    "must_have_session": "Embroidery: digitizing, stabilizer and hooping"
  },
  {
    "topics": "Finding the bottleneck on your own floor | Where is that job right now: production tracking and shop software | Hiring, training and keeping good people | Succession: what happens to your shop when you stop | Burnout and the isolation of running a shop",
    "must_have_session": "Succession: what happens to your shop when you stop"
  },
  {
    "topics": "Short runs without losing money | Reading your own P&L and balance sheet | Buying used equipment without getting burned | Finding the bottleneck on your own floor | Company stores, fundraising and program work",
    "must_have_session": "Short runs without losing money"
  }
];

/**
 * Who respondents said they would drive to hear.
 *
 * NAMES ONLY. "someone like Christy who was passionate about everything" and
 * "any CEO of a true small business who bit the dust and rose from the ashes"
 * are not names, and a speaker record called either would sit in the list
 * forever as a joke. Those answers are in the deploy notes where a person can
 * read them and decide.
 */
export const FOC26_WISHLIST = [
  {
    "name": "Tom Raun",
    "company": "Envision Tees",
    "note": "Started on a manual press in his parents' basement and built a multi-machine screen print and embroidery shop. Asked for on pricing through production."
  },
  {
    "name": "Erik Oksnevad",
    "company": "NW Graphic Supply"
  },
  {
    "name": "Christina",
    "company": "B+C / PGM"
  },
  {
    "name": "Dylan",
    "company": "Shirt Show"
  },
  {
    "name": "John Magee"
  },
  {
    "name": "Michelle Moxley"
  },
  {
    "name": "Matt Richardson",
    "note": "Named by one respondent. Check which Matt Richardson: a survey respondent of that name is at Relentless Merch, and a FOC26 speaker of that name is at Atonal Headwear."
  },
  {
    "name": "Ryan (Ryonet)",
    "note": "Written in the survey as 'Ryonet Ryan'. Confirm the actual name before contacting."
  }
];

/**
 * FOC26's sponsors, off the event site's own page.
 *
 * Seeded at status "inquiry" with NO committed amount by the importer. They
 * sponsored last year. They have not agreed to anything for this one, and
 * putting last year's number on this year's board would be money nobody
 * promised.
 */
export const FOC26_SPONSORS = [
  {
    "company": "SanMar",
    "note": "Sponsored FOC26. Not yet approached about FOC27."
  },
  {
    "company": "Limitless Transfers",
    "note": "Sponsored FOC26. Not yet approached about FOC27."
  },
  {
    "company": "PrintGrip",
    "note": "Sponsored FOC26. Not yet approached about FOC27."
  },
  {
    "company": "Chipply",
    "note": "Sponsored FOC26. Not yet approached about FOC27."
  },
  {
    "company": "S&S Activewear",
    "note": "Sponsored FOC26. Not yet approached about FOC27."
  },
  {
    "company": "SPSI",
    "note": "Sponsored FOC26. Not yet approached about FOC27."
  },
  {
    "company": "Embellishr",
    "note": "Sponsored FOC26. Not yet approached about FOC27."
  },
  {
    "company": "Atonal Headwear",
    "note": "Sponsored FOC26. Not yet approached about FOC27."
  }
];
