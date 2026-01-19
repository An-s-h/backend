/**
 * Geographic utility functions
 * For calculating distances between locations (zip codes, cities, etc.)
 */

/**
 * Calculate distance between two coordinates using Haversine formula
 * @param {number} lat1 - Latitude of first point
 * @param {number} lon1 - Longitude of first point
 * @param {number} lat2 - Latitude of second point
 * @param {number} lon2 - Longitude of second point
 * @returns {number} - Distance in miles
 */
export function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 3959; // Earth's radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(degrees) {
  return (degrees * Math.PI) / 180;
}

/**
 * Parse location string to extract coordinates
 * This is a simplified version - in production, you'd use a geocoding service
 * @param {string} location - Location string (e.g., "90210", "Los Angeles, CA")
 * @returns {Object|null} - {lat, lon} or null if not parseable
 */
export function parseLocation(location) {
  // This is a placeholder - in production, use a geocoding API
  // For now, return null to indicate we can't parse it
  // The actual implementation would use Google Geocoding API, Mapbox, etc.
  return null;
}

/**
 * Check if a location is within radius of another location
 * @param {Object} location1 - {lat, lon} or location string
 * @param {Object} location2 - {lat, lon} or location string
 * @param {number} radiusMiles - Radius in miles
 * @returns {boolean} - True if within radius
 */
export function isWithinRadius(location1, location2, radiusMiles) {
  // If we can't parse locations, return true (don't filter out)
  // This is a fallback - in production, you'd always have coordinates
  if (!location1 || !location2) return true;

  const coords1 = typeof location1 === "object" ? location1 : parseLocation(location1);
  const coords2 = typeof location2 === "object" ? location2 : parseLocation(location2);

  if (!coords1 || !coords2) return true; // Can't determine, so include

  const distance = calculateDistance(
    coords1.lat,
    coords1.lon,
    coords2.lat,
    coords2.lon
  );

  return distance <= radiusMiles;
}

