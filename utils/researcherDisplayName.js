/**
 * Build display name for researchers: "Dr. [Name], [Credentials]"
 * e.g. "Dr. Ahmed Hasan, MD PHD"
 * @param {string} nameOrUsername - Full name or username (e.g. "Ahmed Hasan")
 * @param {{ profession?: string, certifications?: string[] }} researcher - Profile.researcher
 * @returns {string}
 */
export function getResearcherDisplayName(nameOrUsername, researcher) {
  const name = (nameOrUsername || "").trim() || "Researcher";
  const parts = [];
  if (researcher?.profession) {
    parts.push(String(researcher.profession).trim());
  }
  if (Array.isArray(researcher?.certifications) && researcher.certifications.length > 0) {
    researcher.certifications.forEach((c) => {
      const s = String(c).trim();
      if (s) parts.push(s);
    });
  }
  const credentials = parts.join(" ").trim();
  const prefix = "Dr. ";
  if (credentials) {
    return `${prefix}${name}, ${credentials}`;
  }
  return `${prefix}${name}`;
}

/**
 * Enrich authorUserId objects (in place) with displayName when role is researcher.
 * @param {Array<{ authorUserId?: { _id, username, role, ... } }>} items - Posts, threads, replies, or comments
 * @param {Record<string, { researcher?: { profession?, certifications?[] } }>} profileMap - Map of userId string -> Profile
 */
export function enrichAuthorsWithDisplayName(items, profileMap) {
  if (!items || !profileMap) return;
  items.forEach((item) => {
    const author = item.authorUserId;
    if (!author || author.role !== "researcher") return;
    const uid = author._id?.toString?.() || author.toString?.();
    const profile = profileMap[uid];
    if (profile?.researcher) {
      author.displayName = getResearcherDisplayName(
        author.username || author.name,
        profile.researcher
      );
    }
  });
}
