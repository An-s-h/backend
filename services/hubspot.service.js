import axios from "axios";

/**
 * HubSpot Forms API Service
 * 
 * This service handles form submissions to HubSpot using the Forms API v3.
 * Documentation: https://developers.hubspot.com/docs/api/marketing/forms
 */

const HUBSPOT_API_BASE = "https://api.hsforms.com/submissions/v3/integration/submit";

/**
 * Submit form data to HubSpot
 * @param {Object} formData - The form data to submit
 * @param {string} formData.firstName - User's first name
 * @param {string} formData.lastName - User's last name
 * @param {string} formData.email - User's email address
 * @param {string} [formData.role] - User's role (optional)
 * @param {string} [formData.country] - User's country (optional)
 * @param {string} [formData.hubspotCookie] - HubSpot tracking cookie (hubspotutk) for contact association (optional)
 * @param {string} [formData.ipAddress] - Client IP address for analytics and geolocation (optional)
 * @returns {Promise<Object>} - Response from HubSpot API
 */
export async function submitToHubSpot(formData) {
  const { firstName, lastName, email, role, country, hubspotCookie, ipAddress } = formData;

  // Get HubSpot configuration from environment variables
  const portalId = process.env.HUBSPOT_PORTAL_ID;
  const formGuid = process.env.HUBSPOT_FORM_GUID;

  // Debug: Log environment variable status (without exposing values)
  console.log("HubSpot Config Check:", {
    hasPortalId: !!portalId,
    hasFormGuid: !!formGuid,
    portalIdLength: portalId?.length || 0,
    formGuidLength: formGuid?.length || 0,
  });

  // Validate required environment variables
  if (!portalId || !formGuid) {
    const missing = [];
    if (!portalId) missing.push("HUBSPOT_PORTAL_ID");
    if (!formGuid) missing.push("HUBSPOT_FORM_GUID");
    
    throw new Error(
      `HubSpot configuration missing. Please set ${missing.join(" and ")} in your .env file. ` +
      `Make sure the .env file is in the server directory and the server has been restarted.`
    );
  }

  // Validate required form data
  if (!firstName || !lastName || !email) {
    throw new Error("First name, last name, and email are required");
  }

  // Build the submission URL
  const submitUrl = `${HUBSPOT_API_BASE}/${portalId}/${formGuid}`;

  // Prepare the data payload according to HubSpot Forms API v3 format
  // Field names should match the field names in your HubSpot form
  const fields = [
    {
      name: "firstname",
      value: firstName.trim(),
    },
    {
      name: "lastname",
      value: lastName.trim(),
    },
    {
      name: "email",
      value: email.trim().toLowerCase(),
    },
  ];

  // Add optional fields if provided
  if (role) {
    fields.push({
      name: "role", // Make sure this field exists in your HubSpot form
      value: role.trim(),
    });
  }

  if (country) {
    fields.push({
      name: "country", // Make sure this field exists in your HubSpot form
      value: country.trim(),
    });
  }

  // Prepare the request body
  const context = {
    pageUri: process.env.FRONTEND_URL || "https://your-landing-page.com",
    pageName: "Waitlist Form",
  };

  // Add HubSpot tracking cookie (hutk) if provided
  // This enables contact association, analytics, and source tracking
  if (hubspotCookie) {
    context.hutk = hubspotCookie;
  }

  // Add IP address if provided
  // This enables geolocation tracking and improves form analytics
  if (ipAddress) {
    context.ipAddress = ipAddress;
  }

  const requestBody = {
    fields: fields,
    context: context,
    // Note: Legal consent options are optional
    // If your HubSpot account requires GDPR consent, you may need to add legalConsentOptions
    // For now, we'll keep it simple and let HubSpot handle defaults
  };

  try {
    const response = await axios.post(submitUrl, requestBody, {
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 10000, // 10 second timeout
    });

    return {
      success: true,
      data: response.data,
      message: "Successfully submitted to HubSpot",
    };
  } catch (error) {
    // Handle different types of errors
    if (error.response) {
      // HubSpot API returned an error response
      console.error("HubSpot API Error:", error.response.data);
      throw new Error(
        `HubSpot API Error: ${error.response.data?.message || error.response.statusText}`
      );
    } else if (error.request) {
      // Request was made but no response received
      console.error("HubSpot Network Error:", error.message);
      throw new Error("Failed to connect to HubSpot. Please try again later.");
    } else {
      // Something else happened
      console.error("HubSpot Error:", error.message);
      throw error;
    }
  }
}

/**
 * Test HubSpot connection
 * This is a helper function to verify your HubSpot configuration
 * @returns {Promise<boolean>} - True if connection is successful
 */
export async function testHubSpotConnection() {
  const portalId = process.env.HUBSPOT_PORTAL_ID;
  const formGuid = process.env.HUBSPOT_FORM_GUID;

  if (!portalId || !formGuid) {
    return false;
  }

  // You can add a simple test here if needed
  // For now, just check if the environment variables are set
  return true;
}

