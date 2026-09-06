#!/usr/bin/env node

/**
 * JIRA Configuration Comparator
 *
 * A comprehensive Node.js script to compare configurations between source and target JIRA Cloud instances.
 * This script verifies differences in issue types, link types, priority schemes, issue hierarchy,
 * sprint configuration, and time tracking settings.
 *
 * Usage:
 *   node jira-config-comparator.js --source https://source-instance.atlassian.net \
 *                                   --target https://target-instance.atlassian.net \
 *                                   --email your.email@company.com \
 *                                   --token your-api-token
 *
 * Requirements:
 *   npm install node-fetch
 */

// Use native https module instead of fetch for better control
const https = require("https");
const { program } = require("commander");
const fs = require("fs").promises;
const path = require("path");

class JIRAConfigComparator {
  constructor(sourceUrl, targetUrl, email, apiToken, options = {}) {
    this.sourceUrl = sourceUrl.replace(/\/$/, "");
    this.targetUrl = targetUrl.replace(/\/$/, "");
    this.outputDir = options.outputDir || ".";
    this.options = {
      severityThreshold: options.severity || "low",
      ignoreDescriptions: options.ignoreDescriptions || false,
      businessCriticalOnly: options.businessCriticalOnly || false,
      summary: options.summary || false,
    };
    this.auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
    this.headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Basic ${this.auth}`,
    };
    this.sourceConfig = {};
    this.targetConfig = {};
  }

  // Helper method for paginated API calls
  async makePaginatedApiCall(baseUrl, endpoint, params = {}) {
    const maxResults = params.maxResults || 50;
    let startAt = params.startAt || 0;
    let allResults = [];
    let hasMore = true;

    while (hasMore) {
      // Build endpoint URL with query parameters
      let paginatedEndpoint = endpoint;
      const queryParams = {
        ...params,
        startAt,
        maxResults,
      };

      // Remove pagination params from the params object copy
      delete queryParams.startAt;
      delete queryParams.maxResults;

      // Build query string
      const queryParts = [`startAt=${startAt}`, `maxResults=${maxResults}`];
      Object.keys(queryParams).forEach((key) => {
        queryParts.push(
          `${encodeURIComponent(key)}=${encodeURIComponent(queryParams[key])}`,
        );
      });

      // Add query string to endpoint
      const separator = endpoint.includes("?") ? "&" : "?";
      paginatedEndpoint = `${endpoint}${separator}${queryParts.join("&")}`;

      const response = await this.makeApiCall(baseUrl, paginatedEndpoint);

      if (!response) {
        break;
      }

      // Handle different response structures
      let values = [];
      let isPaginated = false;

      if (response.values && Array.isArray(response.values)) {
        values = response.values;
        isPaginated = true;
      } else if (response.issues && Array.isArray(response.issues)) {
        values = response.issues;
        isPaginated = true;
      } else if (response.views && Array.isArray(response.views)) {
        values = response.views;
        isPaginated = true;
      } else if (Array.isArray(response)) {
        // Direct array response - not paginated
        allResults = response;

        break; // Don't paginate further
      } else {
        console.warn(
          `Unexpected response structure for ${endpoint}:`,
          typeof response,
        );
        break;
      }

      allResults = allResults.concat(values);

      // Check if there are more pages (only for paginated responses)
      if (!isPaginated) {
        console.log(`Non-paginated response, ending pagination`);
        hasMore = false;
      } else if (
        response.isLast === true ||
        (response.total &&
          response.startAt + response.maxResults >= response.total) ||
        (!response.isLast && !response.total && values.length < maxResults)
      ) {
        hasMore = false;
      } else {
        startAt += maxResults;
      }

      // Safety check to prevent infinite loops
      if (startAt > 1000 || allResults.length > 1000) {
        console.warn(
          `Pagination safety limit reached for endpoint: ${endpoint}`,
        );
        break;
      }
    }

    return allResults;
  }

  async makeApiCall(
    baseUrl,
    endpoint,
    method = "GET",
    body = null,
    retryCount = 0,
    maxRetries = 5,
  ) {
    return new Promise((resolve, reject) => {
      // Parse the base URL to get hostname
      const hostname = baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");

      const options = {
        hostname: hostname,
        port: 443,
        path: endpoint,
        method: method,
        headers: {
          Authorization: `Basic ${this.auth}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      };

      const req = https.request(options, async (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", async () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            // Handle 204 No Content
            if (res.statusCode === 204) {
              resolve({ success: true });
              return;
            }

            try {
              const parsed = data ? JSON.parse(data) : {};
              resolve(parsed);
            } catch (e) {
              resolve({ success: true });
            }
          } else if (res.statusCode === 429 && retryCount < maxRetries) {
            // Rate limited - implement exponential backoff
            const backoffTime = Math.min(1000 * Math.pow(2, retryCount), 32000);
            console.log(
              `   ⏳ Rate limited, retrying in ${backoffTime / 1000}s (attempt ${retryCount + 1}/${maxRetries})...`,
            );
            await new Promise((r) => setTimeout(r, backoffTime));

            try {
              const result = await this.makeApiCall(
                baseUrl,
                endpoint,
                method,
                body,
                retryCount + 1,
                maxRetries,
              );
              resolve(result);
            } catch (retryError) {
              reject(retryError);
            }
          } else {
            const errorText = data.substring(0, 500);
            reject(new Error(`HTTP ${res.statusCode}: ${errorText}`));
          }
        });
      });

      req.on("error", (error) => {
        reject(error);
      });

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  // Get all issue types
  async getIssueTypes(baseUrl) {
    return await this.makeApiCall(baseUrl, "/rest/api/3/issuetype");
  }

  // Get all issue type schemes (handles both Classic and Next-Gen projects)
  async getIssueTypeSchemes(baseUrl) {
    try {
      console.log(`🔍 Fetching Issue Type Schemes from ${baseUrl}`);

      // Try Classic projects first
      const classicData = await this.makePaginatedApiCall(
        baseUrl,
        "/rest/api/3/issuetypescheme",
      );
      const classicSchemes = classicData?.values || classicData || [];

      console.log(
        `✅ Classic Issue Type Schemes: Found ${classicSchemes.length} schemes`,
      );

      // Also try Next-Gen (Team-managed) projects approach
      const nextGenSchemes = await this.getNextGenIssueTypeSchemes(baseUrl);

      const allSchemes = [
        ...(Array.isArray(classicSchemes) ? classicSchemes : []),
        ...(nextGenSchemes || []),
      ];
      console.log(
        `✅ Total Issue Type Schemes: Found ${allSchemes.length} schemes (Classic + Next-Gen)`,
      );

      return allSchemes;
    } catch (error) {
      console.error(`❌ Error fetching Issue Type Schemes: ${error.message}`);
      console.log(`🔄 Trying alternative approach via project details...`);

      // Alternative: Extract scheme information from project details
      return await this.getIssueTypeSchemesFromProjects(baseUrl);
    }
  }

  // Get Next-Gen (Team-managed) issue type schemes
  async getNextGenIssueTypeSchemes(baseUrl) {
    try {
      console.log(`🔍 Fetching Next-Gen Issue Type Schemes from ${baseUrl}`);

      // Get all projects and filter for Next-Gen projects
      const projects = await this.makePaginatedApiCall(
        baseUrl,
        "/rest/api/3/project/search",
      );
      const projectList = Array.isArray(projects)
        ? projects
        : projects?.values || [];
      console.log(`🔍 DEBUG: Project list length: ${projectList.length}`);

      const nextGenProjects = projectList.filter(
        (project) =>
          project.style === "next-gen" ||
          (project.projectTypeKey === "software" && !project.simplified),
      );

      console.log(`🔍 Found ${nextGenProjects.length} Next-Gen projects`);

      // For Next-Gen projects, issue types are configured at the project level
      const schemeMap = new Map();

      for (const project of nextGenProjects) {
        try {
          // Get project's issue types using correct endpoint
          const issueTypes = await this.makeApiCall(
            baseUrl,
            `/rest/api/3/issuetype/project?projectId=${project.id}`,
          );

          if (issueTypes && issueTypes.length > 0) {
            const schemeKey = `next-gen-${project.id}`;
            schemeMap.set(schemeKey, {
              id: schemeKey,
              name: `${project.name} - Next-Gen Scheme`,
              description: `Next-Gen project issue type scheme for ${project.name}`,
              isDefault: false,
              projectId: project.id,
              projectName: project.name,
              projectKey: project.key,
              issueTypes: issueTypes,
              style: "next-gen",
            });
          }
        } catch (issueTypeError) {
          console.log(
            `⚠️  Could not get issue types for Next-Gen project ${project.key}: ${issueTypeError.message}`,
          );
        }
      }

      const result = Array.from(schemeMap.values());
      console.log(
        `✅ Next-Gen Issue Type Schemes: Found ${result.length} schemes`,
      );

      return result;
    } catch (error) {
      console.error(
        `❌ Error fetching Next-Gen Issue Type Schemes: ${error.message}`,
      );
      return [];
    }
  }

  // Alternative method to get issue type schemes from project details
  async getIssueTypeSchemesFromProjects(baseUrl) {
    try {
      console.log(`🔍 Extracting Issue Type Schemes from project details`);

      // Get all projects first
      const projects = await this.makePaginatedApiCall(
        baseUrl,
        "/rest/api/3/project/search",
      );
      const projectList = Array.isArray(projects)
        ? projects
        : projects?.values || [];

      const schemeMap = new Map();

      for (const project of projectList) {
        if (project.issueTypeScheme) {
          const schemeId = project.issueTypeScheme.id;
          if (!schemeMap.has(schemeId)) {
            // Get detailed scheme information
            try {
              const schemeDetails = await this.makeApiCall(
                baseUrl,
                `/rest/api/3/issuetypescheme/${schemeId}`,
              );
              schemeMap.set(schemeId, schemeDetails);
            } catch (schemeError) {
              // Create minimal scheme info from project data
              schemeMap.set(schemeId, {
                id: schemeId,
                name: project.issueTypeScheme.name || `Scheme ${schemeId}`,
                description: project.issueTypeScheme.description || "",
                isDefault: project.issueTypeScheme.isDefault || false,
              });
            }
          }
        }
      }

      const result = Array.from(schemeMap.values());
      console.log(
        `✅ Alternative method: Found ${result.length} issue type schemes`,
      );
      return result;
    } catch (error) {
      console.error(`❌ Alternative method also failed: ${error.message}`);
      return [];
    }
  }

  // Get all issue link types
  async getIssueLinkTypes(baseUrl) {
    const data = await this.makeApiCall(baseUrl, "/rest/api/3/issueLinkType");
    return data?.issueLinkTypes || data || [];
  }

  // Get all workflows
  async getWorkflows(baseUrl) {
    const data = await this.makeApiCall(baseUrl, "/rest/api/3/workflow");
    return data?.workflows || data || [];
  }

  // Get all workflow schemes
  async getWorkflowSchemes(baseUrl) {
    const data = await this.makePaginatedApiCall(
      baseUrl,
      "/rest/api/3/workflowscheme",
    );
    return data?.values || data || [];
  }

  // Get all custom fields
  async getCustomFields(baseUrl) {
    const data = await this.makePaginatedApiCall(baseUrl, "/rest/api/3/field");
    return data || [];
  }

  // Get all field configurations (handles both Classic and Next-Gen projects)
  async getFieldConfigurations(baseUrl) {
    try {
      console.log(`🔍 Fetching Field Configurations from ${baseUrl}`);

      // Try Classic projects first
      const classicData = await this.makePaginatedApiCall(
        baseUrl,
        "/rest/api/3/fieldconfiguration",
      );
      const classicConfigs = classicData?.values || classicData || [];

      console.log(
        `✅ Classic Field Configurations: Found ${classicConfigs.length} configs`,
      );

      // Also try Next-Gen (Team-managed) projects approach
      const nextGenConfigs = await this.getNextGenFieldConfigurations(baseUrl);

      const allConfigs = [
        ...(Array.isArray(classicConfigs) ? classicConfigs : []),
        ...(nextGenConfigs || []),
      ];
      console.log(
        `✅ Total Field Configurations: Found ${allConfigs.length} configs (Classic + Next-Gen)`,
      );

      return allConfigs;
    } catch (error) {
      console.error(`❌ Error fetching Field Configurations: ${error.message}`);
      return [];
    }
  }

  // Get Next-Gen (Team-managed) field configurations
  async getNextGenFieldConfigurations(baseUrl) {
    try {
      console.log(`🔍 Fetching Next-Gen Field Configurations from ${baseUrl}`);

      // Get all projects and filter for Next-Gen projects
      const projects = await this.makePaginatedApiCall(
        baseUrl,
        "/rest/api/3/project/search",
      );
      const projectList = Array.isArray(projects)
        ? projects
        : projects?.values || [];

      const nextGenProjects = projectList.filter(
        (project) =>
          project.style === "next-gen" ||
          (project.projectTypeKey === "software" && !project.simplified),
      );

      console.log(`🔍 Found ${nextGenProjects.length} Next-Gen projects`);

      // For Next-Gen projects, field configurations are simplified
      const configMap = new Map();

      for (const project of nextGenProjects) {
        try {
          // For Next-Gen projects, fields are global and not scheme-specific
          // Create a placeholder field configuration since Next-Gen doesn't use traditional field configs
          const configKey = `next-gen-fields-${project.id}`;
          configMap.set(configKey, {
            id: configKey,
            name: `${project.name} - Next-Gen Field Configuration`,
            description: `Next-Gen project uses global field configuration for ${project.name}`,
            isDefault: false,
            projectId: project.id,
            projectName: project.name,
            projectKey: project.key,
            style: "next-gen",
            note: "Next-Gen projects use global field configuration instead of scheme-based configuration",
          });
        } catch (fieldError) {
          console.log(
            `⚠️  Could not create field config for Next-Gen project ${project.key}: ${fieldError.message}`,
          );
        }
      }

      const result = Array.from(configMap.values());
      console.log(
        `✅ Next-Gen Field Configurations: Found ${result.length} configs`,
      );

      return result;
    } catch (error) {
      console.error(
        `❌ Error fetching Next-Gen Field Configurations: ${error.message}`,
      );
      return [];
    }
  }

  // Get all screen schemes (handles both Classic and Next-Gen projects)
  async getScreenSchemes(baseUrl) {
    try {
      console.log(`🔍 Fetching Screen Schemes from ${baseUrl}`);

      // Try Classic projects first
      const classicData = await this.makePaginatedApiCall(
        baseUrl,
        "/rest/api/3/screenscheme",
      );
      const classicSchemes = classicData?.values || classicData || [];

      console.log(
        `✅ Classic Screen Schemes: Found ${classicSchemes.length} schemes`,
      );

      // Also try Next-Gen (Team-managed) projects approach
      const nextGenSchemes = await this.getNextGenScreenSchemes(baseUrl);

      const allSchemes = [
        ...(Array.isArray(classicSchemes) ? classicSchemes : []),
        ...(nextGenSchemes || []),
      ];
      console.log(
        `✅ Total Screen Schemes: Found ${allSchemes.length} schemes (Classic + Next-Gen)`,
      );

      return allSchemes;
    } catch (error) {
      console.error(`❌ Error fetching Screen Schemes: ${error.message}`);
      return [];
    }
  }

  // Get Next-Gen (Team-managed) screen schemes
  async getNextGenScreenSchemes(baseUrl) {
    try {
      console.log(`🔍 Fetching Next-Gen Screen Schemes from ${baseUrl}`);

      // Get all projects and filter for Next-Gen projects
      const projects = await this.makePaginatedApiCall(
        baseUrl,
        "/rest/api/3/project/search",
      );
      const projectList = Array.isArray(projects)
        ? projects
        : projects?.values || [];

      const nextGenProjects = projectList.filter(
        (project) =>
          project.style === "next-gen" ||
          (project.projectTypeKey === "software" && !project.simplified),
      );

      console.log(`🔍 Found ${nextGenProjects.length} Next-Gen projects`);

      // For Next-Gen projects, screens are configured at the project level
      const schemeMap = new Map();

      for (const project of nextGenProjects) {
        try {
          // Get project's screens (this might not be directly available for Next-Gen)
          // Next-Gen projects use a different screen model, so we'll create a placeholder
          const schemeKey = `next-gen-screen-${project.id}`;
          schemeMap.set(schemeKey, {
            id: schemeKey,
            name: `${project.name} - Next-Gen Screen Configuration`,
            description: `Next-Gen project screen configuration for ${project.name}`,
            isDefault: false,
            projectId: project.id,
            projectName: project.name,
            projectKey: project.key,
            style: "next-gen",
            note: "Next-Gen projects use simplified screen configuration",
          });
        } catch (screenError) {
          console.log(
            `⚠️  Could not get screens for Next-Gen project ${project.key}: ${screenError.message}`,
          );
        }
      }

      const result = Array.from(schemeMap.values());
      console.log(`✅ Next-Gen Screen Schemes: Found ${result.length} schemes`);

      return result;
    } catch (error) {
      console.error(
        `❌ Error fetching Next-Gen Screen Schemes: ${error.message}`,
      );
      return [];
    }
  }

  // Get all permission schemes
  async getPermissionSchemes(baseUrl) {
    const data = await this.makeApiCall(
      baseUrl,
      "/rest/api/3/permissionscheme",
    );
    return data?.permissionSchemes || data || [];
  }

  // Get all notification schemes
  async getNotificationSchemes(baseUrl) {
    const data = await this.makeApiCall(
      baseUrl,
      "/rest/api/3/notificationscheme",
    );
    return data?.values || data || [];
  }

  // Get all issue security schemes
  async getIssueSecuritySchemes(baseUrl) {
    const data = await this.makeApiCall(
      baseUrl,
      "/rest/api/3/issuesecurityschemes",
    );
    return data?.issueSecuritySchemes || data || [];
  }

  // Get all project categories
  async getProjectCategories(baseUrl) {
    const data = await this.makeApiCall(baseUrl, "/rest/api/3/projectCategory");
    return data || [];
  }

  // Get all resolutions
  async getResolutions(baseUrl) {
    const data = await this.makeApiCall(baseUrl, "/rest/api/3/resolution");
    return data || [];
  }

  // Get all statuses
  async getStatuses(baseUrl) {
    const data = await this.makeApiCall(baseUrl, "/rest/api/3/status");
    return data || [];
  }

  // Get all priority schemes (handles both Classic and Next-Gen projects)
  async getPrioritySchemes(baseUrl) {
    try {
      console.log(`🔍 Fetching Priority Schemes from ${baseUrl}`);

      // Try Classic projects first
      const classicData = await this.makePaginatedApiCall(
        baseUrl,
        "/rest/api/3/priorityscheme",
      );
      const classicSchemes = classicData?.values || classicData || [];

      console.log(
        `✅ Classic Priority Schemes: Found ${classicSchemes.length} schemes`,
      );

      // Also try Next-Gen (Team-managed) projects approach
      const nextGenSchemes = await this.getNextGenPrioritySchemes(baseUrl);

      const allSchemes = [
        ...(Array.isArray(classicSchemes) ? classicSchemes : []),
        ...(nextGenSchemes || []),
      ];
      console.log(
        `✅ Total Priority Schemes: Found ${allSchemes.length} schemes (Classic + Next-Gen)`,
      );

      return allSchemes;
    } catch (error) {
      console.error(`❌ Error fetching Priority Schemes: ${error.message}`);
      console.log(`🔄 Trying alternative approach via project details...`);

      // Alternative: Extract scheme information from project details
      return await this.getPrioritySchemesFromProjects(baseUrl);
    }
  }

  // Get Next-Gen (Team-managed) priority schemes
  async getNextGenPrioritySchemes(baseUrl) {
    try {
      console.log(`🔍 Fetching Next-Gen Priority Schemes from ${baseUrl}`);

      // Get all projects and filter for Next-Gen projects
      const projects = await this.makePaginatedApiCall(
        baseUrl,
        "/rest/api/3/project/search",
      );
      const projectList = Array.isArray(projects)
        ? projects
        : projects?.values || [];

      const nextGenProjects = projectList.filter(
        (project) =>
          project.style === "next-gen" ||
          (project.projectTypeKey === "software" && !project.simplified),
      );

      console.log(`🔍 Found ${nextGenProjects.length} Next-Gen projects`);

      // For Next-Gen projects, priorities are configured at the project level
      const schemeMap = new Map();

      for (const project of nextGenProjects) {
        try {
          // For Next-Gen projects, priorities are global and not scheme-specific
          // Get global priorities once and reuse
          const globalPriorities = await this.makeApiCall(
            baseUrl,
            `/rest/api/3/priority`,
          );

          if (globalPriorities && globalPriorities.length > 0) {
            const schemeKey = `next-gen-priority-${project.id}`;
            schemeMap.set(schemeKey, {
              id: schemeKey,
              name: `${project.name} - Next-Gen Priority Scheme`,
              description: `Next-Gen project uses global priority scheme for ${project.name}`,
              isDefault: false,
              projectId: project.id,
              projectName: project.name,
              projectKey: project.key,
              priorities: globalPriorities,
              style: "next-gen",
              note: "Next-Gen projects use global priority configuration instead of scheme-based configuration",
            });
          }
        } catch (priorityError) {
          console.log(
            `⚠️  Could not get priorities for Next-Gen project ${project.key}: ${priorityError.message}`,
          );
        }
      }

      const result = Array.from(schemeMap.values());
      console.log(
        `✅ Next-Gen Priority Schemes: Found ${result.length} schemes`,
      );

      return result;
    } catch (error) {
      console.error(
        `❌ Error fetching Next-Gen Priority Schemes: ${error.message}`,
      );
      return [];
    }
  }

  // Alternative method to get priority schemes from project details
  async getPrioritySchemesFromProjects(baseUrl) {
    try {
      console.log(`🔍 Extracting Priority Schemes from project details`);

      // Get all projects first
      const projects = await this.makePaginatedApiCall(
        baseUrl,
        "/rest/api/3/project/search",
      );
      const projectList = Array.isArray(projects)
        ? projects
        : projects?.values || [];

      const schemeMap = new Map();

      for (const project of projectList) {
        if (project.priorityScheme) {
          const schemeId = project.priorityScheme.id;
          if (!schemeMap.has(schemeId)) {
            // Get detailed scheme information
            try {
              const schemeDetails = await this.makeApiCall(
                baseUrl,
                `/rest/api/3/priorityscheme/${schemeId}`,
              );
              schemeMap.set(schemeId, schemeDetails);
            } catch (schemeError) {
              // Create minimal scheme info from project data
              schemeMap.set(schemeId, {
                id: schemeId,
                name:
                  project.priorityScheme.name || `Priority Scheme ${schemeId}`,
                description: project.priorityScheme.description || "",
                isDefault: project.priorityScheme.isDefault || false,
              });
            }
          }
        }
      }

      const result = Array.from(schemeMap.values());
      console.log(
        `✅ Alternative method: Found ${result.length} priority schemes`,
      );
      return result;
    } catch (error) {
      console.error(`❌ Alternative method also failed: ${error.message}`);
      return [];
    }
  }

  // Get priorities
  async getPriorities(baseUrl) {
    return await this.makeApiCall(baseUrl, "/rest/api/3/priority");
  }

  // Get issue hierarchy (project configurations)
  async getIssueHierarchy(baseUrl) {
    // Get all projects (this endpoint returns a direct array, not paginated)
    const projects = await this.makeApiCall(baseUrl, "/rest/api/3/project");
    if (!projects) return null;

    console.log(`Found ${projects.length} total projects`);

    // Filter for active projects only and add safety limit
    const activeProjects = projects
      .filter(
        (project) =>
          project &&
          project.key &&
          project.name &&
          !project.archived &&
          project.projectTypeKey !== "template",
      )
      .slice(0, 100); // Reasonable limit for comparison

    console.log(`Analyzing ${activeProjects.length} active projects`);

    // Get all issue type schemes with project mappings
    const issueTypeSchemes = await this.makePaginatedApiCall(
      baseUrl,
      "/rest/api/3/issuetypescheme/mapping",
    );

    // Get all priority schemes
    const prioritySchemes = await this.makePaginatedApiCall(
      baseUrl,
      "/rest/api/3/priorityscheme",
    );

    const hierarchyData = [];

    // Use filtered active projects
    const projectsToAnalyze = activeProjects;
    console.log(`Analyzing ${projectsToAnalyze.length} active projects`);

    for (const project of projectsToAnalyze) {
      const projectId = project.id;
      const projectKey = project.key;

      // Get project's issue type scheme using project ID
      let issueTypes = null;
      try {
        issueTypes = await this.makePaginatedApiCall(
          baseUrl,
          `/rest/api/3/issuetypescheme/project?projectId=${projectId}`,
        );
      } catch (error) {
        // Silent fail - some projects may not have accessible issue type schemes
      }

      // Find project's priority scheme from the list
      let priorityScheme = null;
      if (prioritySchemes && Array.isArray(prioritySchemes)) {
        priorityScheme = prioritySchemes.find(
          (scheme) =>
            scheme.projects &&
            (scheme.projects.values || scheme.projects) &&
            (scheme.projects.values || scheme.projects).some(
              (proj) => proj.id === projectId,
            ),
        );
      }

      hierarchyData.push({
        projectKey,
        projectName: project.name,
        projectType: project.projectTypeKey,
        issueTypes: issueTypes || [],
        priorityScheme: priorityScheme || null,
      });
    }

    return hierarchyData;
  }

  // Get sprint configuration (JIRA Software/Agile)
  async getSprintConfiguration(baseUrl) {
    // Get all boards using modern Agile API with pagination
    const boards = await this.makePaginatedApiCall(
      baseUrl,
      "/rest/agile/1.0/board",
    );
    if (!boards) return null;

    console.log(`Found ${boards.length} boards`);

    const sprintConfigs = [];

    // Get configuration for each board (limit to first 20 to avoid overwhelming)
    const boardsToAnalyze = boards.slice(0, 20);
    console.log(`Analyzing ${boardsToAnalyze.length} boards`);

    for (const board of boardsToAnalyze) {
      try {
        const config = await this.makeApiCall(
          baseUrl,
          `/rest/agile/1.0/board/${board.id}/configuration`,
        );
        if (config) {
          sprintConfigs.push({
            boardId: board.id,
            boardName: board.name,
            boardType: board.type,
            sprintConfig: config,
          });
        }
      } catch (error) {
        console.warn(
          `Could not get configuration for board ${board.name} (${board.id}):`,
          error.message,
        );
      }
    }

    return sprintConfigs;
  }

  // Get time tracking configuration (Time Booking settings)
  async getTimeTrackingConfiguration(baseUrl) {
    // Get main time tracking configuration
    const timeTrackingConfig = await this.makeApiCall(
      baseUrl,
      "/rest/api/3/configuration/timetracking",
    );

    // Get time tracking options
    const timeTrackingOptions = await this.makeApiCall(
      baseUrl,
      "/rest/api/3/configuration/timetracking/options",
    );

    // Get time tracking list configuration
    const timeTrackingList = await this.makeApiCall(
      baseUrl,
      "/rest/api/3/configuration/timetracking/list",
    );

    return {
      configuration: timeTrackingConfig,
      options: timeTrackingOptions,
      list: timeTrackingList,
    };
  }

  // ============================================================================
  // DATA MIGRATION VERIFICATION METHODS
  // ============================================================================

  // Helper method for paginated JQL search using nextPageToken (new endpoint)
  async makeJqlSearchWithToken(baseUrl, jql, fields = null, maxResults = 1000) {
    let allIssues = [];
    let nextPageToken = null;
    let hasMore = true;
    let pageCount = 0;

    while (hasMore) {
      // Build endpoint with proper URL encoding
      let endpoint = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}`;

      if (fields) {
        endpoint += `&fields=${encodeURIComponent(fields)}`;
      }

      if (nextPageToken) {
        endpoint += `&nextPageToken=${encodeURIComponent(nextPageToken)}`;
      }

      try {
        const response = await this.makeApiCall(baseUrl, endpoint);

        // Check if response is valid
        if (!response) {
          console.warn(`No response received for JQL: ${jql}`);
          break;
        }

        // Check if issues array exists
        if (!response.issues || !Array.isArray(response.issues)) {
          console.warn(
            `Invalid or missing issues array in response for JQL: ${jql}`,
          );
          break;
        }

        // If we got an empty page, stop
        if (response.issues.length === 0) {
          break;
        }

        allIssues = allIssues.concat(response.issues);
        pageCount++;

        // Check if there are more pages
        if (response.nextPageToken) {
          nextPageToken = response.nextPageToken;
        } else {
          hasMore = false;
        }

        // Safety check to prevent infinite loops (max 100k issues)
        if (allIssues.length > 100000) {
          console.warn(
            `⚠️  Safety limit reached for JQL: ${jql}. Stopping at ${allIssues.length} issues after ${pageCount} pages.`,
          );
          break;
        }

        // Additional safety: max 1000 pages
        if (pageCount > 1000) {
          console.warn(
            `⚠️  Page limit reached for JQL: ${jql}. Stopping after ${pageCount} pages with ${allIssues.length} issues.`,
          );
          break;
        }
      } catch (error) {
        console.error(`❌ Error in JQL search for "${jql}": ${error.message}`);
        // Don't throw - return what we have so far to allow script to continue
        console.warn(
          `⚠️  Returning ${allIssues.length} issues collected before error`,
        );
        break;
      }
    }

    return allIssues;
  }

  // Helper to escape JQL values
  escapeJqlValue(value) {
    // Escape quotes and backslashes in JQL string values
    if (typeof value !== "string") {
      return value;
    }
    // Replace backslashes first, then quotes
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // Get issue counts per project
  async getProjectIssueCounts(baseUrl, projectKeys) {
    console.log(
      `🔍 Fetching issue counts for ${projectKeys.length} projects from ${baseUrl}`,
    );
    const counts = {};

    for (const key of projectKeys) {
      try {
        const escapedKey = this.escapeJqlValue(key);
        // Use bounded query for approximate count endpoint
        const jql = `project = "${escapedKey}" ORDER BY created DESC`;
        // Use approximate-count endpoint (POST with JSON body)
        const endpoint = `/rest/api/3/search/approximate-count`;
        const body = { jql };
        const result = await this.makeApiCall(baseUrl, endpoint, "POST", body);
        counts[key] = result?.count || 0;
        console.log(`   ✓ ${key}: ${counts[key]} issues`);
      } catch (error) {
        console.error(
          `   ✗ ${key}: Error fetching issue count - ${error.message}`,
        );
        counts[key] = -1; // Mark as error
      }
    }

    return counts;
  }

  // Get comment counts per project
  async getProjectCommentCounts(baseUrl, projectKeys) {
    console.log(
      `🔍 Fetching comment counts for ${projectKeys.length} projects from ${baseUrl}`,
    );
    const counts = {};

    for (const key of projectKeys) {
      try {
        const escapedKey = this.escapeJqlValue(key);
        // /search/jql requires bounded query - add ORDER BY
        const jql = `project = "${escapedKey}" ORDER BY created DESC`;
        // Use new /search/jql endpoint with nextPageToken for unlimited pagination
        const issues = await this.makeJqlSearchWithToken(
          baseUrl,
          jql,
          "comment",
          1000,
        );

        // Ensure issues is an array
        if (!Array.isArray(issues)) {
          console.warn(
            `   ⚠️  ${key}: Unexpected response format for comments`,
          );
          counts[key] = 0;
          continue;
        }

        let totalComments = 0;
        for (const issue of issues) {
          if (issue.fields && issue.fields.comment) {
            // Use the total field which is more accurate
            totalComments += issue.fields.comment.total || 0;
          }
        }

        counts[key] = totalComments;
        console.log(
          `   ✓ ${key}: ${totalComments} comments (from ${issues.length} issues)`,
        );
      } catch (error) {
        console.error(
          `   ✗ ${key}: Error fetching comment count - ${error.message}`,
        );
        counts[key] = -1; // Mark as error
      }
    }

    return counts;
  }

  // Get attachment counts per project
  async getProjectAttachmentCounts(baseUrl, projectKeys) {
    console.log(
      `🔍 Fetching attachment counts for ${projectKeys.length} projects from ${baseUrl}`,
    );
    const counts = {};

    for (const key of projectKeys) {
      try {
        const escapedKey = this.escapeJqlValue(key);
        // /search/jql requires bounded query - add ORDER BY
        const jql = `project = "${escapedKey}" ORDER BY created DESC`;
        // Use new /search/jql endpoint with nextPageToken for unlimited pagination
        const issues = await this.makeJqlSearchWithToken(
          baseUrl,
          jql,
          "attachment",
          1000,
        );

        // Ensure issues is an array
        if (!Array.isArray(issues)) {
          console.warn(
            `   ⚠️  ${key}: Unexpected response format for attachments`,
          );
          counts[key] = 0;
          continue;
        }

        let totalAttachments = 0;
        for (const issue of issues) {
          if (
            issue.fields &&
            issue.fields.attachment &&
            Array.isArray(issue.fields.attachment)
          ) {
            totalAttachments += issue.fields.attachment.length;
          }
        }

        counts[key] = totalAttachments;
        console.log(
          `   ✓ ${key}: ${totalAttachments} attachments (from ${issues.length} issues)`,
        );
      } catch (error) {
        console.error(
          `   ✗ ${key}: Error fetching attachment count - ${error.message}`,
        );
        counts[key] = -1; // Mark as error
      }
    }

    return counts;
  }

  // Get issue link counts per project
  async getProjectIssueLinkCounts(baseUrl, projectKeys) {
    console.log(
      `🔍 Fetching issue link counts for ${projectKeys.length} projects from ${baseUrl}`,
    );
    const counts = {};

    for (const key of projectKeys) {
      try {
        const escapedKey = this.escapeJqlValue(key);
        // /search/jql requires bounded query - add ORDER BY
        const jql = `project = "${escapedKey}" ORDER BY created DESC`;
        // Use new /search/jql endpoint with nextPageToken for unlimited pagination
        const issues = await this.makeJqlSearchWithToken(
          baseUrl,
          jql,
          "issuelinks",
          1000,
        );

        // Ensure issues is an array
        if (!Array.isArray(issues)) {
          console.warn(
            `   ⚠️  ${key}: Unexpected response format for issue links`,
          );
          counts[key] = 0;
          continue;
        }

        let totalLinks = 0;
        for (const issue of issues) {
          if (
            issue.fields &&
            issue.fields.issuelinks &&
            Array.isArray(issue.fields.issuelinks)
          ) {
            totalLinks += issue.fields.issuelinks.length;
          }
        }

        counts[key] = totalLinks;
        console.log(
          `   ✓ ${key}: ${totalLinks} issue links (from ${issues.length} issues)`,
        );
      } catch (error) {
        console.error(
          `   ✗ ${key}: Error fetching issue link count - ${error.message}`,
        );
        counts[key] = -1; // Mark as error
      }
    }

    return counts;
  }

  // Get comprehensive project data stats
  async getProjectDataStats(baseUrl, projectKeys) {
    console.log(
      `\n📊 Fetching comprehensive data stats for projects from ${baseUrl}`,
    );

    const stats = {
      issueCounts: await this.getProjectIssueCounts(baseUrl, projectKeys),
      commentCounts: await this.getProjectCommentCounts(baseUrl, projectKeys),
      attachmentCounts: await this.getProjectAttachmentCounts(
        baseUrl,
        projectKeys,
      ),
      issueLinkCounts: await this.getProjectIssueLinkCounts(
        baseUrl,
        projectKeys,
      ),
    };

    return stats;
  }

  async fetchAllConfigurations() {
    console.log("Fetching configurations from source instance...");

    this.sourceConfig = {
      issueTypes: await this.getIssueTypes(this.sourceUrl),
      issueTypeSchemes: await this.getIssueTypeSchemes(this.sourceUrl),
      issueLinkTypes: await this.getIssueLinkTypes(this.sourceUrl),
      prioritySchemes: await this.getPrioritySchemes(this.sourceUrl),
      priorities: await this.getPriorities(this.sourceUrl),
      issueHierarchy: await this.getIssueHierarchy(this.sourceUrl),
      sprintConfig: await this.getSprintConfiguration(this.sourceUrl),
      timeTrackingConfig: await this.getTimeTrackingConfiguration(
        this.sourceUrl,
      ),
      // Comprehensive configuration areas
      workflows: await this.getWorkflows(this.sourceUrl),
      workflowSchemes: await this.getWorkflowSchemes(this.sourceUrl),
      customFields: await this.getCustomFields(this.sourceUrl),
      fieldConfigurations: await this.getFieldConfigurations(this.sourceUrl),
      screenSchemes: await this.getScreenSchemes(this.sourceUrl),
      permissionSchemes: await this.getPermissionSchemes(this.sourceUrl),
      notificationSchemes: await this.getNotificationSchemes(this.sourceUrl),
      issueSecuritySchemes: await this.getIssueSecuritySchemes(this.sourceUrl),
      projectCategories: await this.getProjectCategories(this.sourceUrl),
      resolutions: await this.getResolutions(this.sourceUrl),
      statuses: await this.getStatuses(this.sourceUrl),
    };

    console.log("Fetching configurations from target instance...");

    this.targetConfig = {
      issueTypes: await this.getIssueTypes(this.targetUrl),
      issueTypeSchemes: await this.getIssueTypeSchemes(this.targetUrl),
      issueLinkTypes: await this.getIssueLinkTypes(this.targetUrl),
      prioritySchemes: await this.getPrioritySchemes(this.targetUrl),
      priorities: await this.getPriorities(this.targetUrl),
      issueHierarchy: await this.getIssueHierarchy(this.targetUrl),
      sprintConfig: await this.getSprintConfiguration(this.targetUrl),
      timeTrackingConfig: await this.getTimeTrackingConfiguration(
        this.targetUrl,
      ),
      // Comprehensive configuration areas
      workflows: await this.getWorkflows(this.targetUrl),
      workflowSchemes: await this.getWorkflowSchemes(this.targetUrl),
      customFields: await this.getCustomFields(this.targetUrl),
      fieldConfigurations: await this.getFieldConfigurations(this.targetUrl),
      screenSchemes: await this.getScreenSchemes(this.targetUrl),
      permissionSchemes: await this.getPermissionSchemes(this.targetUrl),
      notificationSchemes: await this.getNotificationSchemes(this.targetUrl),
      issueSecuritySchemes: await this.getIssueSecuritySchemes(this.targetUrl),
      projectCategories: await this.getProjectCategories(this.targetUrl),
      resolutions: await this.getResolutions(this.targetUrl),
      statuses: await this.getStatuses(this.targetUrl),
    };

    // Get project keys from source (only compare projects that came from source)
    const sourceProjectKeys = this.sourceConfig.issueHierarchy
      ? this.sourceConfig.issueHierarchy.map((p) => p.projectKey)
      : [];

    if (sourceProjectKeys.length > 0) {
      console.log(
        `\n📊 Fetching project data statistics for ${sourceProjectKeys.length} source projects...`,
      );

      // Fetch data stats for source projects
      this.sourceConfig.projectDataStats = await this.getProjectDataStats(
        this.sourceUrl,
        sourceProjectKeys,
      );

      // Fetch data stats for same projects on target (filtering out pre-existing target data)
      this.targetConfig.projectDataStats = await this.getProjectDataStats(
        this.targetUrl,
        sourceProjectKeys,
      );
    } else {
      console.log("\n⚠️  No projects found to analyze for data statistics");
    }
  }

  compareLists(sourceList, targetList, keyField, nameField, itemType = "") {
    const sourceItems = new Map();
    const targetItems = new Map();

    // Ensure we have arrays, handle cases where API returns null or objects
    const sourceArray = Array.isArray(sourceList)
      ? sourceList
      : sourceList && sourceList.values
        ? sourceList.values
        : [];
    const targetArray = Array.isArray(targetList)
      ? targetList
      : targetList && targetList.values
        ? targetList.values
        : [];

    // Enhanced logic to handle duplicate names and missing names
    (sourceArray || []).forEach((item) => {
      const key = this.getComparisonKey(item, keyField, nameField);
      if (key) {
        // If key already exists, store as array to handle duplicates
        if (sourceItems.has(key)) {
          const existing = sourceItems.get(key);
          if (Array.isArray(existing)) {
            existing.push(item);
          } else {
            sourceItems.set(key, [existing, item]);
          }
        } else {
          sourceItems.set(key, item);
        }
      }
    });

    (targetArray || []).forEach((item) => {
      const key = this.getComparisonKey(item, keyField, nameField);
      if (key) {
        // If key already exists, store as array to handle duplicates
        if (targetItems.has(key)) {
          const existing = targetItems.get(key);
          if (Array.isArray(existing)) {
            existing.push(item);
          } else {
            targetItems.set(key, [existing, item]);
          }
        } else {
          targetItems.set(key, item);
        }
      }
    });

    const sourceKeys = new Set(sourceItems.keys());
    const targetKeys = new Set(targetItems.keys());

    const missingInTarget = [...sourceKeys].filter(
      (key) => !targetKeys.has(key),
    );
    const extraInTarget = [...targetKeys].filter((key) => !sourceKeys.has(key));
    const commonKeys = [...sourceKeys].filter((key) => targetKeys.has(key));

    const differences = [];

    for (const key of commonKeys) {
      const sourceItem = sourceItems.get(key);
      const targetItem = targetItems.get(key);

      // Handle both single items and arrays of duplicate items
      const sourceItemsToCompare = Array.isArray(sourceItem)
        ? sourceItem
        : [sourceItem];
      const targetItemsToCompare = Array.isArray(targetItem)
        ? targetItem
        : [targetItem];

      // Compare each source item with each target item
      for (const sItem of sourceItemsToCompare) {
        for (const tItem of targetItemsToCompare) {
          // Clean items for comparison (remove self URLs and timestamps)
          const sourceClean = this.cleanItem(sItem);
          const targetClean = this.cleanItem(tItem);

          // Check for meaningful differences with severity scoring
          const diffResult = this.hasMeaningfulDifferencesWithSeverity(
            sItem,
            tItem,
            keyField,
            itemType,
          );

          if (diffResult.hasDifferences) {
            // Filter by severity threshold if specified
            if (this.options.severityThreshold) {
              const thresholdOrder = {
                low: 1,
                medium: 2,
                high: 3,
                critical: 4,
              };
              const diffOrder = thresholdOrder[diffResult.severity] || 0;
              const thresholdOrderVal =
                thresholdOrder[this.options.severityThreshold] || 0;

              if (diffOrder < thresholdOrderVal) {
                continue; // Skip this difference as it's below threshold
              }
            }

            differences.push({
              key,
              name: sItem[nameField] || key,
              source: this.cleanItemEnhanced(sItem, itemType),
              target: this.cleanItemEnhanced(tItem, itemType),
              severity: diffResult.severity,
              reason: diffResult.reason,
              importance: this.categorizeItemImportance(sItem, itemType),
            });
          }
        }
      }
    }

    return {
      missingInTarget: missingInTarget.flatMap((key) => {
        const item = sourceItems.get(key);
        return Array.isArray(item) ? item : [item];
      }),
      extraInTarget: extraInTarget.flatMap((key) => {
        const item = targetItems.get(key);
        return Array.isArray(item) ? item : [item];
      }),
      differences,
      sourceCount: (sourceList || []).length,
      targetCount: (targetList || []).length,
    };
  }

  getComparisonKey(item, keyField, nameField) {
    // Try the primary key field first
    let key = item[keyField];

    // If key is missing or empty, try the name field
    if (!key && nameField && item[nameField]) {
      key = item[nameField];
    }

    // If still no key, try ID as fallback
    if (!key && item.id) {
      key = item.id;
    }

    // Normalize key for consistent comparison (trim whitespace, lowercase for names)
    if (typeof key === "string") {
      key = key.trim();
      // Only lowercase if we're comparing by name (not ID)
      if (keyField === "name" || nameField === "name") {
        key = key.toLowerCase();
      }
    }

    return key;
  }

  hasMeaningfulDifferences(sourceItem, targetItem, keyField) {
    // Since cleanItem already removes problematic fields, just compare the cleaned items
    return JSON.stringify(sourceItem) !== JSON.stringify(targetItem);
  }

  // Enhanced cleaning method to remove migration artifacts
  cleanItemEnhanced(item, itemType = "") {
    if (!item || typeof item !== "object") return item;

    const cleaned = {};
    Object.keys(item).forEach((key) => {
      // Remove fields that cause false differences between instances
      const fieldsToIgnore = [
        "self",
        "expand",
        "id",
        "iconUrl",
        "avatarId",
        "untranslatedName",
        "scope", // Contains project-specific IDs that will differ
        // Workflow metadata that always changes during migration
        "lastModifiedDate",
        "lastModifiedUser",
        "lastModifiedUserAccountId",
        "createdDate",
        "createdUser",
        "createdUserAccountId",
      ];

      if (!fieldsToIgnore.includes(key)) {
        let value = item[key];

        // Handle different data types
        if (typeof value === "string") {
          // Remove migration timestamp patterns
          value = value.replace(
            /\s*\(Migrated on \d{1,2} [A-Za-z]{3} \d{4} \d{1,2}:\d{2}:\d{2} [A-Z]{3,4}\)\s*/g,
            "",
          );

          // Remove any URLs
          if (value.includes("http")) {
            return; // Skip URL fields entirely
          }

          // Normalize whitespace
          value = value.trim().replace(/\s+/g, " ");

          // For custom field names, normalize ID patterns
          if (key === "name" && itemType === "customField") {
            value = value.replace(/\s*\(ID:\s*[^)]+\)\s*/g, "");
          }
        }

        // For custom field IDs, normalize to generic pattern
        if (
          key === "key" &&
          typeof value === "string" &&
          value.includes("customfield_")
        ) {
          value = "customfield_[ID]";
        }

        cleaned[key] = value;
      }
    });
    return cleaned;
  }

  // Check if differences are benign (expected migration artifacts)
  isBenignDifference(sourceValue, targetValue, field) {
    // Workflow metadata that always changes during migration
    if (
      [
        "lastModifiedDate",
        "lastModifiedUser",
        "lastModifiedUserAccountId",
        "createdDate",
        "createdUser",
        "createdUserAccountId",
      ].includes(field)
    ) {
      return true;
    }

    if (typeof sourceValue !== "string" || typeof targetValue !== "string") {
      return false;
    }

    // Check for migration timestamp additions
    const sourceClean = sourceValue
      .replace(/\s*\(Migrated on [^)]+\)\s*/g, "")
      .trim();
    const targetClean = targetValue
      .replace(/\s*\(Migrated on [^)]+\)\s*/g, "")
      .trim();

    if (sourceClean === targetClean) {
      return true; // Only difference is migration timestamp
    }

    // Check for custom field ID differences
    if (
      field === "key" &&
      sourceValue.match(/customfield_\d+/) &&
      targetValue.match(/customfield_\d+/)
    ) {
      return true; // Custom field ID reassignment is expected
    }

    // Check for user account ID differences (expected in migration)
    if (
      field.includes("AccountId") &&
      sourceValue.match(/712020:[a-f0-9-]{36}/) &&
      targetValue.match(/712020:[a-f0-9-]{36}/)
    ) {
      return true;
    }

    return false;
  }

  // Categorize item importance for severity scoring
  categorizeItemImportance(item, itemType) {
    if (!item || !item.name) return "low";
    const name = item.name.toLowerCase();

    switch (itemType) {
      case "project":
        // LOW priority projects
        if (
          name.includes("test") ||
          name.includes("demo") ||
          name.includes("archive") ||
          name.includes("old") ||
          name.includes("sandbox") ||
          name.includes("sample") ||
          name.includes("example") ||
          // Personal projects - look for single person names in parentheses
          (/^[^(]+\([^)]*\)$/.test(item.name) &&
            (name.includes("garnett") ||
              name.includes("dan") ||
              /^[a-z]+\s+[a-z]+$/i.test(item.name.split("(")[0].trim()))) ||
          // Internal tools and utilities
          name.includes("toolbox") ||
          name.includes("utility") ||
          name.includes("internal") ||
          name.includes("productivity") ||
          // Vendor/partner projects
          name.includes("expleo") ||
          name.includes("forvia") ||
          name.includes("vendor")
        ) {
          return "low";
        }
        // CRITICAL projects - core business functions
        if (
          name.includes("security") ||
          name.includes("control") ||
          name.includes("system") ||
          name.includes("software") ||
          name.includes("hardware") ||
          name.includes("customer") ||
          name.includes("electric") ||
          name.includes("electronic") ||
          name.includes("diagnostic") ||
          name.includes("validation") ||
          name.includes("durability") ||
          name.includes("emissions") ||
          name.includes("safety")
        ) {
          return "critical";
        }
        // HIGH priority projects - important but not core business
        if (
          name.includes("development") ||
          name.includes("engineering") ||
          name.includes("procurement") ||
          name.includes("marketing") ||
          name.includes("product") ||
          name.includes("integration") ||
          name.includes("architecture") ||
          name.includes("network")
        ) {
          return "high";
        }
        return "medium";

      case "issueType":
        // Critical system issue types
        if (
          name.includes("incident") ||
          name.includes("service request") ||
          name.includes("approval") ||
          name.includes("bug") ||
          name.includes("fault") ||
          name.includes("epic")
        ) {
          return "critical";
        }
        if (
          name.includes("subtask") ||
          name.includes("task") ||
          name.includes("story")
        ) {
          return "high";
        }
        return "medium";

      case "customField":
        // Business-critical custom fields
        if (
          name.includes("product area") ||
          name.includes("roadmap") ||
          name.includes("impact") ||
          name.includes("value") ||
          name.includes("customer") ||
          name.includes("project") ||
          name.includes("uuid") ||
          name.includes("approval")
        ) {
          return "critical";
        }
        if (
          name.includes("tooltip") ||
          name.includes("message") ||
          name.includes("note")
        ) {
          return "low";
        }
        return "medium";

      case "workflow":
        // Critical workflows
        if (name.includes("simplified workflow")) {
          return "low"; // Auto-generated workflows
        }
        if (
          name.includes("copy of") ||
          name.includes("backup") ||
          name.includes("test")
        ) {
          return "low";
        }
        if (
          name.includes("approval") ||
          name.includes("security") ||
          name.includes("incident")
        ) {
          return "critical";
        }
        return "high";

      default:
        return "medium";
    }
  }

  // Enhanced comparison with severity scoring
  hasMeaningfulDifferencesWithSeverity(
    sourceItem,
    targetItem,
    keyField,
    itemType = "",
  ) {
    const sourceClean = this.cleanItemEnhanced(sourceItem, itemType);
    const targetClean = this.cleanItemEnhanced(targetItem, itemType);

    // Check for differences
    const sourceStr = JSON.stringify(sourceClean);
    const targetStr = JSON.stringify(targetClean);

    if (sourceStr === targetStr) {
      return {
        hasDifferences: false,
        severity: "none",
        reason: "No meaningful differences",
      };
    }

    // Analyze what fields differ
    const sourceFields = new Set(Object.keys(sourceClean));
    const targetFields = new Set(Object.keys(targetClean));
    const allFields = new Set([...sourceFields, ...targetFields]);

    let maxSeverity = "low";
    const reasons = [];

    allFields.forEach((field) => {
      const sourceValue = sourceClean[field];
      const targetValue = targetClean[field];

      if (JSON.stringify(sourceValue) !== JSON.stringify(targetValue)) {
        // Check if this is a benign difference
        if (this.isBenignDifference(sourceValue, targetValue, field)) {
          reasons.push(`${field}: benign difference (migration artifact)`);
        } else {
          // Determine severity based on field and item type
          let fieldSeverity = "medium";

          if (field === "description" && this.options.ignoreDescriptions) {
            return; // Skip description differences if requested
          }

          if (field === "description") {
            fieldSeverity = "low";
          } else if (field === "key" && itemType === "customField") {
            fieldSeverity = "low"; // Custom field ID changes are expected
          } else if (["name", "fieldType", "type"].includes(field)) {
            fieldSeverity = "high";
          } else if (["scope", "required", "default"].includes(field)) {
            fieldSeverity = "medium";
          } else if (
            [
              "lastModifiedDate",
              "lastModifiedUser",
              "lastModifiedUserAccountId",
              "createdDate",
              "createdUser",
              "createdUserAccountId",
            ].includes(field)
          ) {
            fieldSeverity = "low"; // Workflow metadata changes are expected during migration
          }

          // Upgrade severity based on item importance
          const itemImportance = this.categorizeItemImportance(
            sourceItem,
            itemType,
          );
          if (itemImportance === "critical") {
            fieldSeverity = "critical";
          } else if (
            itemImportance === "high" &&
            fieldSeverity !== "critical"
          ) {
            fieldSeverity = "high";
          }

          reasons.push(`${field}: ${fieldSeverity} severity`);
          maxSeverity = this.getHigherSeverity(maxSeverity, fieldSeverity);
        }
      }
    });

    return {
      hasDifferences: true,
      severity: maxSeverity,
      reason: reasons.join("; "),
    };
  }

  // Helper to get higher severity
  getHigherSeverity(sev1, sev2) {
    const severityOrder = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
    return severityOrder[sev1] >= severityOrder[sev2] ? sev1 : sev2;
  }

  cleanItem(item) {
    if (!item || typeof item !== "object") return item;

    const cleaned = {};
    Object.keys(item).forEach((key) => {
      // Remove fields that cause false differences between instances
      const fieldsToIgnore = [
        "self",
        "expand",
        "id",
        "iconUrl",
        "avatarId",
        "untranslatedName",
        "scope", // Contains project-specific IDs that will differ
      ];

      if (!fieldsToIgnore.includes(key)) {
        // Also remove any URL fields (they will always be different between instances)
        if (typeof item[key] === "string" && item[key].includes("http")) {
          return; // Skip URL fields
        }
        cleaned[key] = item[key];
      }
    });
    return cleaned;
  }

  formatConfigSection(title, comparisonResult) {
    const output = [
      `\n${"=".repeat(60)}`,
      title,
      "=".repeat(60),
      `Source: ${comparisonResult.sourceCount} items`,
      `Target: ${comparisonResult.targetCount} items`,
    ];

    // Group missing items by importance
    const missingCritical = [];
    const missingHigh = [];
    const missingMedium = [];
    const missingLow = [];

    comparisonResult.missingInTarget.forEach((item) => {
      const importance = this.categorizeItemImportance(
        item,
        this.getItemTypeFromTitle(title),
      );
      const name = item.name || item.id || "Unknown";
      const itemWithImportance = { name, id: item.id || "N/A", importance };

      // Debug output for project categorization
      if (this.getItemTypeFromTitle(title) === "project") {
        console.log(
          `🔍 DEBUG: Project "${name}" categorized as ${importance} priority`,
        );
      }

      switch (importance) {
        case "critical":
          missingCritical.push(itemWithImportance);
          break;
        case "high":
          missingHigh.push(itemWithImportance);
          break;
        case "medium":
          missingMedium.push(itemWithImportance);
          break;
        case "low":
          missingLow.push(itemWithImportance);
          break;
      }
    });

    // Display missing items by severity
    if (missingCritical.length > 0) {
      output.push(
        `\n🚨 CRITICAL MISSING IN TARGET (${missingCritical.length} items):`,
      );
      missingCritical.forEach((item) => {
        output.push(`   - ${item.name} (ID: ${item.id})`);
      });
    }

    if (missingHigh.length > 0 && !this.options.businessCriticalOnly) {
      output.push(
        `\n❌ HIGH PRIORITY MISSING IN TARGET (${missingHigh.length} items):`,
      );
      missingHigh.forEach((item) => {
        output.push(`   - ${item.name} (ID: ${item.id})`);
      });
    }

    if (missingMedium.length > 0 && !this.options.businessCriticalOnly) {
      output.push(
        `\n⚠️  MEDIUM PRIORITY MISSING IN TARGET (${missingMedium.length} items):`,
      );
      missingMedium.forEach((item) => {
        output.push(`   - ${item.name} (ID: ${item.id})`);
      });
    }

    if (missingLow.length > 0 && !this.options.businessCriticalOnly) {
      output.push(
        `\n📝 LOW PRIORITY MISSING IN TARGET (${missingLow.length} items):`,
      );
      missingLow.forEach((item) => {
        output.push(`   - ${item.name} (ID: ${item.id})`);
      });
    }

    // Group differences by severity
    const criticalDiffs = comparisonResult.differences.filter(
      (d) => d.severity === "critical",
    );
    const highDiffs = comparisonResult.differences.filter(
      (d) => d.severity === "high",
    );
    const mediumDiffs = comparisonResult.differences.filter(
      (d) => d.severity === "medium",
    );
    const lowDiffs = comparisonResult.differences.filter(
      (d) => d.severity === "low",
    );

    // Display differences by severity
    if (criticalDiffs.length > 0) {
      output.push(`\n🚨 CRITICAL DIFFERENCES (${criticalDiffs.length} items):`);
      this.formatDifferences(criticalDiffs, output);
    }

    if (highDiffs.length > 0 && !this.options.businessCriticalOnly) {
      output.push(
        `\n❌ HIGH PRIORITY DIFFERENCES (${highDiffs.length} items):`,
      );
      this.formatDifferences(highDiffs, output);
    }

    if (mediumDiffs.length > 0 && !this.options.businessCriticalOnly) {
      output.push(
        `\n⚠️  MEDIUM PRIORITY DIFFERENCES (${mediumDiffs.length} items):`,
      );
      this.formatDifferences(mediumDiffs, output);
    }

    if (lowDiffs.length > 0 && !this.options.businessCriticalOnly) {
      output.push(`\n📝 LOW PRIORITY DIFFERENCES (${lowDiffs.length} items):`);
      this.formatDifferences(lowDiffs, output);
    }

    if (
      comparisonResult.missingInTarget.length === 0 &&
      comparisonResult.extraInTarget.length === 0 &&
      comparisonResult.differences.length === 0
    ) {
      output.push("\n✅ Configurations are identical");
    }

    return output.join("\n");
  }

  // Helper method to format individual differences
  formatDifferences(differences, output) {
    differences.forEach((diff) => {
      output.push(
        `\n   📋 ${diff.name} (ID: ${diff.key}) [${diff.severity.toUpperCase()}]`,
      );
      if (diff.reason && !this.options.summary) {
        output.push(`      Reason: ${diff.reason}`);
      }

      if (!this.options.summary) {
        const sourceFields = new Set(Object.keys(diff.source));
        const targetFields = new Set(Object.keys(diff.target));

        const missingFields = [...sourceFields].filter(
          (f) => !targetFields.has(f),
        );
        const extraFields = [...targetFields].filter(
          (f) => !sourceFields.has(f),
        );
        const commonFields = [...sourceFields].filter((f) =>
          targetFields.has(f),
        );

        if (missingFields.length > 0) {
          output.push(`      Missing in target: ${missingFields.join(", ")}`);
        }
        if (extraFields.length > 0) {
          output.push(`      Extra in target: ${extraFields.join(", ")}`);
        }

        commonFields.forEach((field) => {
          if (
            JSON.stringify(diff.source[field]) !==
            JSON.stringify(diff.target[field])
          ) {
            output.push(`      ${field}:`);
            output.push(
              `        Source: ${JSON.stringify(diff.source[field])}`,
            );
            output.push(
              `        Target: ${JSON.stringify(diff.target[field])}`,
            );
          }
        });
      }
    });
  }

  // Helper to determine item type from section title
  getItemTypeFromTitle(title) {
    const titleLower = title.toLowerCase();
    if (titleLower.includes("project")) return "project";
    if (titleLower.includes("issue type")) return "issueType";
    if (titleLower.includes("custom field")) return "customField";
    if (titleLower.includes("workflow")) return "workflow";
    if (titleLower.includes("priority")) return "priority";
    if (titleLower.includes("scheme")) return "scheme";
    return "unknown";
  }

  formatHierarchySection() {
    const output = [
      "\n" + "=".repeat(60),
      "ISSUE HIERARCHY (PROJECTS)",
      "=".repeat(60),
    ];

    const sourceProjects = this.sourceConfig.issueHierarchy || [];
    const targetProjects = this.targetConfig.issueHierarchy || [];

    output.push(`Source projects: ${sourceProjects.length}`);
    output.push(`Target projects: ${targetProjects.length}`);

    // Debug: Check for duplicate project keys
    const sourceProjectKeysList = sourceProjects.map((p) => p.projectKey);
    const targetProjectKeysList = targetProjects.map((p) => p.projectKey);
    const sourceKeyDuplicates = sourceProjectKeysList.filter(
      (key, index) => sourceProjectKeysList.indexOf(key) !== index,
    );
    const targetKeyDuplicates = targetProjectKeysList.filter(
      (key, index) => targetProjectKeysList.indexOf(key) !== index,
    );

    if (sourceKeyDuplicates.length > 0) {
      output.push(
        `\n🔍 DEBUG: Source duplicate project keys: ${sourceKeyDuplicates.join(", ")}`,
      );
    }
    if (targetKeyDuplicates.length > 0) {
      output.push(
        `🔍 DEBUG: Target duplicate project keys: ${targetKeyDuplicates.join(", ")}`,
      );
    }

    const sourceProjectKeys = new Set(sourceProjects.map((p) => p.projectKey));
    const targetProjectKeys = new Set(targetProjects.map((p) => p.projectKey));

    // Debug: Show actual unique counts
    output.push(
      `🔍 DEBUG: Unique source project keys: ${sourceProjectKeys.size}`,
    );
    output.push(
      `🔍 DEBUG: Unique target project keys: ${targetProjectKeys.size}`,
    );

    const missingInTarget = [...sourceProjectKeys].filter(
      (key) => !targetProjectKeys.has(key),
    );
    const extraInTarget = [...targetProjectKeys].filter(
      (key) => !sourceProjectKeys.has(key),
    );
    const commonProjects = [...sourceProjectKeys].filter((key) =>
      targetProjectKeys.has(key),
    );

    // Debug: Verify the math
    output.push(`🔍 DEBUG: Missing in target: ${missingInTarget.length}`);
    output.push(`🔍 DEBUG: Extra in target: ${extraInTarget.length}`);
    output.push(`🔍 DEBUG: Common projects: ${commonProjects.length}`);
    output.push(
      `🔍 DEBUG: Math check: ${missingInTarget.length} + ${extraInTarget.length} + ${commonProjects.length} = ${missingInTarget.length + extraInTarget.length + commonProjects.length}`,
    );

    if (missingInTarget.length > 0) {
      output.push(
        `\n❌ PROJECTS MISSING IN TARGET (${missingInTarget.length}):`,
      );
      missingInTarget.forEach((key) => {
        const project = sourceProjects.find((p) => p.projectKey === key);
        output.push(`   - ${project.projectName} (${key})`);
      });
    }

    // Extra projects in target are ignored - we only care about source projects missing in target
    // This is intentional as target having more projects is not a problem

    // Compare common projects
    let projectDifferences = 0;
    commonProjects.forEach((key) => {
      const sourceProject = sourceProjects.find((p) => p.projectKey === key);
      const targetProject = targetProjects.find((p) => p.projectKey === key);

      if (sourceProject.projectType !== targetProject.projectType) {
        projectDifferences++;
        output.push(`\n⚠️  Project ${key} type differs:`);
        output.push(`    Source: ${sourceProject.projectType}`);
        output.push(`    Target: ${targetProject.projectType}`);
      }
    });

    if (
      projectDifferences === 0 &&
      missingInTarget.length === 0 &&
      extraInTarget.length === 0
    ) {
      output.push("\n✅ Project hierarchies are identical");
    }

    return output.join("\n");
  }

  formatSprintSection() {
    const output = [
      "\n" + "=".repeat(60),
      "SPRINT CONFIGURATION",
      "=".repeat(60),
    ];

    const sourceBoards = this.sourceConfig.sprintConfig || [];
    const targetBoards = this.targetConfig.sprintConfig || [];

    output.push(`Source boards: ${sourceBoards.length}`);
    output.push(`Target boards: ${targetBoards.length}`);

    if (sourceBoards.length === 0 && targetBoards.length === 0) {
      output.push(
        "⚠️  No sprint boards found on either instance (JIRA Software may not be installed)",
      );
    } else if (sourceBoards.length !== targetBoards.length) {
      output.push(`⚠️  Different number of sprint boards`);

      const sourceBoardNames = sourceBoards.map((b) => b.boardName);
      const targetBoardNames = targetBoards.map((b) => b.boardName);

      const missingBoards = sourceBoardNames.filter(
        (name) => !targetBoardNames.includes(name),
      );
      const extraBoards = targetBoardNames.filter(
        (name) => !sourceBoardNames.includes(name),
      );

      if (missingBoards.length > 0) {
        output.push(`\n❌ BOARDS MISSING IN TARGET:`);
        missingBoards.forEach((name) => output.push(`   - ${name}`));
      }

      if (extraBoards.length > 0) {
        output.push(`\n➕ EXTRA BOARDS IN TARGET:`);
        extraBoards.forEach((name) => output.push(`   - ${name}`));
      }
    } else {
      output.push("✅ Same number of sprint boards found");

      // Compare board types
      const sourceBoardTypes = new Set(sourceBoards.map((b) => b.boardType));
      const targetBoardTypes = new Set(targetBoards.map((b) => b.boardType));

      if (
        JSON.stringify([...sourceBoardTypes].sort()) !==
        JSON.stringify([...targetBoardTypes].sort())
      ) {
        output.push("\n⚠️  Different board types found:");
        output.push(`    Source types: ${[...sourceBoardTypes].join(", ")}`);
        output.push(`    Target types: ${[...targetBoardTypes].join(", ")}`);
      }
    }

    return output.join("\n");
  }

  formatTimeTrackingSection() {
    const output = [
      "\n" + "=".repeat(60),
      "TIME TRACKING CONFIGURATION",
      "=".repeat(60),
    ];

    const sourceTimeTracking = this.sourceConfig.timeTrackingConfig;
    const targetTimeTracking = this.targetConfig.timeTrackingConfig;

    if (!sourceTimeTracking && !targetTimeTracking) {
      output.push(
        "⚠️  Time tracking configuration not available on either instance",
      );
      return output.join("\n");
    }

    if (!sourceTimeTracking && targetTimeTracking) {
      output.push(
        "❌ Time tracking configuration available on target but NOT on source",
      );
      return output.join("\n");
    }

    if (sourceTimeTracking && !targetTimeTracking) {
      output.push(
        "➕ Time tracking configuration available on source but NOT on target",
      );
      return output.join("\n");
    }

    // Compare main configuration
    output.push("\n📋 Main Configuration:");
    if (sourceTimeTracking.configuration && targetTimeTracking.configuration) {
      const sourceConfig = sourceTimeTracking.configuration;
      const targetConfig = targetTimeTracking.configuration;

      // Compare key settings
      const keyFields = [
        "workingDaysPerWeek",
        "workingHoursPerDay",
        "timeTrackingEnabled",
      ];

      keyFields.forEach((field) => {
        if (sourceConfig[field] !== targetConfig[field]) {
          output.push(`   ⚠️  ${field}:`);
          output.push(`     Source: ${JSON.stringify(sourceConfig[field])}`);
          output.push(`     Target: ${JSON.stringify(targetConfig[field])}`);
        }
      });

      if (
        keyFields.every((field) => sourceConfig[field] === targetConfig[field])
      ) {
        output.push("   ✅ Main time tracking settings are identical");
      }
    }

    // Compare options
    output.push("\n📋 Time Tracking Options:");
    if (sourceTimeTracking.options && targetTimeTracking.options) {
      const sourceOptions = sourceTimeTracking.options;
      const targetOptions = targetTimeTracking.options;

      // Compare option settings
      const optionFields = ["defaultUnit", "timeFormat"];

      optionFields.forEach((field) => {
        if (sourceOptions[field] !== targetOptions[field]) {
          output.push(`   ⚠️  ${field}:`);
          output.push(`     Source: ${JSON.stringify(sourceOptions[field])}`);
          output.push(`     Target: ${JSON.stringify(targetOptions[field])}`);
        }
      });

      if (
        optionFields.every(
          (field) => sourceOptions[field] === targetOptions[field],
        )
      ) {
        output.push("   ✅ Time tracking options are identical");
      }
    }

    // Compare list configuration
    output.push("\n📋 List Configuration:");
    if (sourceTimeTracking.list && targetTimeTracking.list) {
      const sourceList = sourceTimeTracking.list;
      const targetList = targetTimeTracking.list;

      // Compare list settings
      const listFields = ["fieldConfigurationId", "fieldId"];

      listFields.forEach((field) => {
        if (sourceList[field] !== targetList[field]) {
          output.push(`   ⚠️  ${field}:`);
          output.push(`     Source: ${JSON.stringify(sourceList[field])}`);
          output.push(`     Target: ${JSON.stringify(targetList[field])}`);
        }
      });

      if (
        listFields.every((field) => sourceList[field] === targetList[field])
      ) {
        output.push("   ✅ Time tracking list configuration is identical");
      }
    }

    return output.join("\n");
  }

  // Format project data statistics section
  formatProjectDataSection() {
    const output = [
      "\n" + "=".repeat(80),
      "PROJECT DATA MIGRATION VERIFICATION",
      "=".repeat(80),
    ];

    if (
      !this.sourceConfig.projectDataStats ||
      !this.targetConfig.projectDataStats
    ) {
      output.push("⚠️  Project data statistics not available");
      return output.join("\n");
    }

    const sourceStats = this.sourceConfig.projectDataStats;
    const targetStats = this.targetConfig.projectDataStats;

    // Verify stats structure
    if (!sourceStats.issueCounts || !targetStats.issueCounts) {
      output.push("⚠️  Issue count data not available");
      return output.join("\n");
    }

    // Get all project keys from source
    const projectKeys = Object.keys(sourceStats.issueCounts);

    if (projectKeys.length === 0) {
      output.push("\n⚠️  No projects found to analyze");
      return output.join("\n");
    }

    output.push(
      `\nAnalyzing ${projectKeys.length} projects from source instance`,
    );
    output.push("");

    let criticalMismatches = 0;
    let minorMismatches = 0;
    let perfectMatches = 0;

    // Detailed per-project comparison
    projectKeys.forEach((key) => {
      const sourceIssues = sourceStats.issueCounts[key];
      const targetIssues = targetStats.issueCounts[key];
      const sourceComments = sourceStats.commentCounts[key];
      const targetComments = targetStats.commentCounts[key];
      const sourceAttachments = sourceStats.attachmentCounts[key];
      const targetAttachments = targetStats.attachmentCounts[key];
      const sourceLinks = sourceStats.issueLinkCounts[key];
      const targetLinks = targetStats.issueLinkCounts[key];

      // Check for errors
      if (sourceIssues === -1 || targetIssues === -1) {
        output.push(`\n❌ ${key}: ERROR fetching data`);
        criticalMismatches++;
        return;
      }

      // Check if project doesn't exist on target (undefined means project not found)
      if (targetIssues === undefined) {
        output.push(`\n🚨 ${key}: PROJECT NOT FOUND ON TARGET`);
        output.push(
          `   Source has ${sourceIssues} issues but project missing on target!`,
        );
        criticalMismatches++;
        return;
      }

      // Default undefined values to 0 for safe math operations
      const safeSourceComments = sourceComments || 0;
      const safeTargetComments = targetComments || 0;
      const safeSourceAttachments = sourceAttachments || 0;
      const safeTargetAttachments = targetAttachments || 0;
      const safeSourceLinks = sourceLinks || 0;
      const safeTargetLinks = targetLinks || 0;

      // Calculate differences
      const issueDiff = sourceIssues - targetIssues;
      const commentDiff = safeSourceComments - safeTargetComments;
      const attachmentDiff = safeSourceAttachments - safeTargetAttachments;
      const linkDiff = safeSourceLinks - safeTargetLinks;

      // Categorize by severity
      const hasCriticalMismatch = issueDiff !== 0;
      const hasMinorMismatch =
        commentDiff !== 0 || attachmentDiff !== 0 || linkDiff !== 0;

      if (hasCriticalMismatch) {
        criticalMismatches++;
        output.push(`\n🚨 ${key}: CRITICAL MISMATCH`);
        output.push(
          `   Issues:      ${sourceIssues} (source) → ${targetIssues} (target) [Δ ${issueDiff}]`,
        );
        output.push(
          `   Comments:    ${safeSourceComments} (source) → ${safeTargetComments} (target) [Δ ${commentDiff}]`,
        );
        output.push(
          `   Attachments: ${safeSourceAttachments} (source) → ${safeTargetAttachments} (target) [Δ ${attachmentDiff}]`,
        );
        output.push(
          `   Links:       ${safeSourceLinks} (source) → ${safeTargetLinks} (target) [Δ ${linkDiff}]`,
        );
      } else if (hasMinorMismatch) {
        minorMismatches++;
        output.push(`\n⚠️  ${key}: Minor data mismatch`);
        output.push(`   Issues:      ${sourceIssues} ✓`);
        if (commentDiff !== 0) {
          output.push(
            `   Comments:    ${safeSourceComments} (source) → ${safeTargetComments} (target) [Δ ${commentDiff}]`,
          );
        }
        if (attachmentDiff !== 0) {
          output.push(
            `   Attachments: ${safeSourceAttachments} (source) → ${safeTargetAttachments} (target) [Δ ${attachmentDiff}]`,
          );
        }
        if (linkDiff !== 0) {
          output.push(
            `   Links:       ${safeSourceLinks} (source) → ${safeTargetLinks} (target) [Δ ${linkDiff}]`,
          );
        }
      } else {
        perfectMatches++;
        output.push(`\n✅ ${key}: Perfect match`);
        output.push(
          `   Issues: ${sourceIssues}, Comments: ${safeSourceComments}, Attachments: ${safeSourceAttachments}, Links: ${safeSourceLinks}`,
        );
      }
    });

    // Summary
    output.push("\n" + "=".repeat(80));
    output.push("PROJECT DATA SUMMARY");
    output.push("=".repeat(80));
    output.push(`Total projects analyzed: ${projectKeys.length}`);
    output.push(`✅ Perfect matches: ${perfectMatches}`);
    output.push(`⚠️  Minor mismatches: ${minorMismatches}`);
    output.push(`🚨 Critical mismatches: ${criticalMismatches}`);

    if (criticalMismatches > 0) {
      output.push(
        "\n⚠️  RECOMMENDATION: Investigate critical mismatches immediately - issue counts don't match!",
      );
    } else if (minorMismatches > 0) {
      output.push(
        "\n📝 Note: Minor mismatches in comments/attachments/links may be acceptable depending on migration scope",
      );
    } else {
      output.push("\n🎉 All project data migrated successfully!");
    }

    return output.join("\n");
  }

  // Generate critical summary for quick overview
  generateCriticalSummary() {
    const summary = [];
    const criticalIssues = [];

    // Check projects
    if (this.sourceConfig.issueHierarchy && this.targetConfig.issueHierarchy) {
      const sourceProjects = new Set(
        this.sourceConfig.issueHierarchy.map((p) => p.projectKey),
      );
      const targetProjects = new Set(
        this.targetConfig.issueHierarchy.map((p) => p.projectKey),
      );
      const missingProjects = [...sourceProjects].filter(
        (key) => !targetProjects.has(key),
      );

      if (missingProjects.length > 0) {
        // Filter missing projects by importance
        const criticalMissingProjects = missingProjects.filter((key) => {
          const project = this.sourceConfig.issueHierarchy.find(
            (p) => p.projectKey === key,
          );
          return (
            project &&
            this.categorizeItemImportance(project, "project") === "critical"
          );
        });

        if (criticalMissingProjects.length > 0) {
          criticalIssues.push(
            `🚨 ${criticalMissingProjects.length} CRITICAL projects missing in target`,
          );
        }
      }
    }

    // Check issue types
    if (this.sourceConfig.issueTypes && this.targetConfig.issueTypes) {
      const comparison = this.compareLists(
        this.sourceConfig.issueTypes,
        this.targetConfig.issueTypes,
        "name",
        "name",
        "issueType",
      );

      // Only show critical items if business-critical-only is enabled
      let criticalMissing = comparison.missingInTarget.filter(
        (item) =>
          this.categorizeItemImportance(item, "issueType") === "critical",
      );

      if (criticalMissing.length > 0) {
        criticalIssues.push(
          `🚨 ${criticalMissing.length} CRITICAL issue types missing: ${criticalMissing.map((i) => i.name).join(", ")}`,
        );
      }
    }

    // Check custom fields
    if (this.sourceConfig.customFields && this.targetConfig.customFields) {
      const comparison = this.compareLists(
        this.sourceConfig.customFields,
        this.targetConfig.customFields,
        "name",
        "name",
        "customField",
      );

      let criticalMissing = comparison.missingInTarget.filter(
        (item) =>
          this.categorizeItemImportance(item, "customField") === "critical",
      );

      if (criticalMissing.length > 0) {
        criticalIssues.push(
          `🚨 ${criticalMissing.length} CRITICAL custom fields missing: ${criticalMissing.map((i) => i.name).join(", ")}`,
        );
      }
    }

    // Check workflows
    if (this.sourceConfig.workflows && this.targetConfig.workflows) {
      const comparison = this.compareLists(
        this.sourceConfig.workflows,
        this.targetConfig.workflows,
        "name",
        "name",
        "workflow",
      );

      let criticalMissing = comparison.missingInTarget.filter(
        (item) =>
          this.categorizeItemImportance(item, "workflow") === "critical",
      );

      if (criticalMissing.length > 0) {
        criticalIssues.push(
          `🚨 ${criticalMissing.length} CRITICAL workflows missing: ${criticalMissing.map((i) => i.name).join(", ")}`,
        );
      }
    }

    if (criticalIssues.length > 0) {
      summary.push(
        `Found ${criticalIssues.length} CRITICAL issues requiring immediate attention:`,
      );
      summary.push("");
      criticalIssues.forEach((issue) => summary.push(issue));
      summary.push("");
      summary.push(
        "🔍 RECOMMENDATION: Address these issues before completing migration.",
      );
    } else {
      summary.push(
        "✅ No critical issues detected - migration appears to be in good shape.",
      );
    }

    return summary;
  }

  generateComparisonReport() {
    const report = [];

    // Header
    report.push("=".repeat(80));
    report.push("JIRA CONFIGURATION COMPARISON REPORT");
    report.push("=".repeat(80));
    report.push(
      `Generated: ${new Date().toISOString().replace("T", " ").substring(0, 19)}`,
    );
    report.push(`Source: ${this.sourceUrl}`);
    report.push(`Target: ${this.targetUrl}`);
    report.push(
      `Filter: ${this.options.severityThreshold}+ severity${this.options.businessCriticalOnly ? ", business critical only" : ""}${this.options.ignoreDescriptions ? ", ignoring descriptions" : ""}`,
    );
    report.push("=".repeat(80));

    // Critical Summary (if any critical issues found)
    const criticalSummary = this.generateCriticalSummary();
    if (criticalSummary.length > 0) {
      report.push("\n🚨 CRITICAL ISSUES SUMMARY 🚨");
      report.push("=".repeat(80));
      report.push(...criticalSummary);
      report.push("=".repeat(80));
    }

    // Issue Types Comparison
    if (this.sourceConfig.issueTypes && this.targetConfig.issueTypes) {
      const comparison = this.compareLists(
        this.sourceConfig.issueTypes,
        this.targetConfig.issueTypes,
        "name",
        "name",
        "issueType",
      );
      report.push(this.formatConfigSection("ISSUE TYPES", comparison));
    }

    // Issue Type Schemes Comparison
    if (
      this.sourceConfig.issueTypeSchemes &&
      this.targetConfig.issueTypeSchemes
    ) {
      const comparison = this.compareLists(
        this.sourceConfig.issueTypeSchemes,
        this.targetConfig.issueTypeSchemes,
        "name",
        "name",
        "scheme",
      );
      report.push(this.formatConfigSection("ISSUE TYPE SCHEMES", comparison));
    }

    // Issue Link Types Comparison
    if (this.sourceConfig.issueLinkTypes && this.targetConfig.issueLinkTypes) {
      const comparison = this.compareLists(
        this.sourceConfig.issueLinkTypes,
        this.targetConfig.issueLinkTypes,
        "name",
        "name",
        "linkType",
      );
      report.push(this.formatConfigSection("ISSUE LINK TYPES", comparison));

      // Debug: Show why no differences are reported
      report.push(`\n🔍 DEBUG: Issue Link Types Analysis:`);
      report.push(
        `   Source items: ${this.sourceConfig.issueLinkTypes.length}`,
      );
      report.push(
        `   Target items: ${this.targetConfig.issueLinkTypes.length}`,
      );
      report.push(`   Missing in target: ${comparison.missingInTarget.length}`);
      report.push(`   Extra in target: ${comparison.extraInTarget.length}`);
      report.push(`   Differences: ${comparison.differences.length}`);

      if (comparison.missingInTarget.length > 0) {
        report.push(
          `   Missing items: ${comparison.missingInTarget.map((item) => item.name).join(", ")}`,
        );
      }
    }

    // Priority Schemes Comparison
    if (
      this.sourceConfig.prioritySchemes &&
      this.targetConfig.prioritySchemes
    ) {
      const comparison = this.compareLists(
        this.sourceConfig.prioritySchemes,
        this.targetConfig.prioritySchemes,
        "name",
        "name",
        "priorityScheme",
      );
      report.push(this.formatConfigSection("PRIORITY SCHEMES", comparison));
    }

    // Priorities Comparison
    if (this.sourceConfig.priorities && this.targetConfig.priorities) {
      const comparison = this.compareLists(
        this.sourceConfig.priorities,
        this.targetConfig.priorities,
        "name",
        "name",
        "priority",
      );
      report.push(this.formatConfigSection("PRIORITIES", comparison));
    }

    // Issue Hierarchy Comparison
    if (this.sourceConfig.issueHierarchy || this.targetConfig.issueHierarchy) {
      report.push(this.formatHierarchySection());
    }

    // Sprint Configuration Comparison
    if (this.sourceConfig.sprintConfig || this.targetConfig.sprintConfig) {
      report.push(this.formatSprintSection());
    }

    // Time Tracking Configuration Comparison
    if (
      this.sourceConfig.timeTrackingConfig ||
      this.targetConfig.timeTrackingConfig
    ) {
      report.push(this.formatTimeTrackingSection());
    }

    // Project Data Migration Verification
    if (
      this.sourceConfig.projectDataStats ||
      this.targetConfig.projectDataStats
    ) {
      report.push(this.formatProjectDataSection());
    }

    // Comprehensive Configuration Areas
    report.push("\n" + "=".repeat(80));
    report.push("COMPREHENSIVE CONFIGURATION VALIDATION");
    report.push("=".repeat(80));

    // Workflows Comparison
    if (this.sourceConfig.workflows && this.targetConfig.workflows) {
      const comparison = this.compareLists(
        this.sourceConfig.workflows,
        this.targetConfig.workflows,
        "name",
        "name",
        "workflow",
      );
      report.push(this.formatConfigSection("WORKFLOWS", comparison));
    }

    // Workflow Schemes Comparison
    if (
      this.sourceConfig.workflowSchemes &&
      this.targetConfig.workflowSchemes
    ) {
      const comparison = this.compareLists(
        this.sourceConfig.workflowSchemes,
        this.targetConfig.workflowSchemes,
        "name",
        "name",
        "workflowScheme",
      );
      report.push(this.formatConfigSection("WORKFLOW SCHEMES", comparison));
    }

    // Custom Fields Comparison
    if (this.sourceConfig.customFields && this.targetConfig.customFields) {
      const comparison = this.compareLists(
        this.sourceConfig.customFields,
        this.targetConfig.customFields,
        "name",
        "name",
        "customField",
      );
      report.push(this.formatConfigSection("CUSTOM FIELDS", comparison));
    }

    // Field Configurations Comparison
    if (
      this.sourceConfig.fieldConfigurations &&
      this.targetConfig.fieldConfigurations
    ) {
      const comparison = this.compareLists(
        this.sourceConfig.fieldConfigurations,
        this.targetConfig.fieldConfigurations,
        "name",
        "name",
        "fieldConfiguration",
      );
      report.push(this.formatConfigSection("FIELD CONFIGURATIONS", comparison));
    }

    // Screen Schemes Comparison
    if (this.sourceConfig.screenSchemes && this.targetConfig.screenSchemes) {
      const comparison = this.compareLists(
        this.sourceConfig.screenSchemes,
        this.targetConfig.screenSchemes,
        "name",
        "name",
        "screenScheme",
      );
      report.push(this.formatConfigSection("SCREEN SCHEMES", comparison));
    }

    // Permission Schemes Comparison
    if (
      this.sourceConfig.permissionSchemes &&
      this.targetConfig.permissionSchemes
    ) {
      const comparison = this.compareLists(
        this.sourceConfig.permissionSchemes,
        this.targetConfig.permissionSchemes,
        "name",
        "name",
        "permissionScheme",
      );
      report.push(this.formatConfigSection("PERMISSION SCHEMES", comparison));
    }

    // Notification Schemes Comparison
    if (
      this.sourceConfig.notificationSchemes &&
      this.targetConfig.notificationSchemes
    ) {
      const comparison = this.compareLists(
        this.sourceConfig.notificationSchemes,
        this.targetConfig.notificationSchemes,
        "name",
        "name",
        "notificationScheme",
      );
      report.push(this.formatConfigSection("NOTIFICATION SCHEMES", comparison));
    }

    // Issue Security Schemes Comparison
    if (
      this.sourceConfig.issueSecuritySchemes &&
      this.targetConfig.issueSecuritySchemes
    ) {
      const comparison = this.compareLists(
        this.sourceConfig.issueSecuritySchemes,
        this.targetConfig.issueSecuritySchemes,
        "name",
        "name",
        "securityScheme",
      );
      report.push(
        this.formatConfigSection("ISSUE SECURITY SCHEMES", comparison),
      );
    }

    // Project Categories Comparison
    if (
      this.sourceConfig.projectCategories &&
      this.targetConfig.projectCategories
    ) {
      const comparison = this.compareLists(
        this.sourceConfig.projectCategories,
        this.targetConfig.projectCategories,
        "name",
        "name",
        "category",
      );
      report.push(this.formatConfigSection("PROJECT CATEGORIES", comparison));
    }

    // Resolutions Comparison
    if (this.sourceConfig.resolutions && this.targetConfig.resolutions) {
      const comparison = this.compareLists(
        this.sourceConfig.resolutions,
        this.targetConfig.resolutions,
        "name",
        "name",
        "resolution",
      );
      report.push(this.formatConfigSection("RESOLUTIONS", comparison));
    }

    // Statuses Comparison
    if (this.sourceConfig.statuses && this.targetConfig.statuses) {
      const comparison = this.compareLists(
        this.sourceConfig.statuses,
        this.targetConfig.statuses,
        "name",
        "name",
        "status",
      );
      report.push(this.formatConfigSection("STATUSES", comparison));
    }

    // Summary
    report.push("\n" + "=".repeat(80));
    report.push("SUMMARY");
    report.push("=".repeat(80));

    const sections = [
      {
        name: "Issue Types",
        source: this.sourceConfig.issueTypes,
        target: this.targetConfig.issueTypes,
      },
      {
        name: "Issue Type Schemes",
        source: this.sourceConfig.issueTypeSchemes,
        target: this.targetConfig.issueTypeSchemes,
      },
      {
        name: "Issue Link Types",
        source: this.sourceConfig.issueLinkTypes,
        target: this.targetConfig.issueLinkTypes,
      },
      {
        name: "Priority Schemes",
        source: this.sourceConfig.prioritySchemes,
        target: this.targetConfig.prioritySchemes,
      },
      {
        name: "Priorities",
        source: this.sourceConfig.priorities,
        target: this.targetConfig.priorities,
      },
      {
        name: "Time Tracking Configuration",
        source: this.sourceConfig.timeTrackingConfig,
        target: this.targetConfig.timeTrackingConfig,
      },
      // Comprehensive configuration areas
      {
        name: "Workflows",
        source: this.sourceConfig.workflows,
        target: this.targetConfig.workflows,
      },
      {
        name: "Workflow Schemes",
        source: this.sourceConfig.workflowSchemes,
        target: this.targetConfig.workflowSchemes,
      },
      {
        name: "Custom Fields",
        source: this.sourceConfig.customFields,
        target: this.targetConfig.customFields,
      },
      {
        name: "Field Configurations",
        source: this.sourceConfig.fieldConfigurations,
        target: this.targetConfig.fieldConfigurations,
      },
      {
        name: "Screen Schemes",
        source: this.sourceConfig.screenSchemes,
        target: this.targetConfig.screenSchemes,
      },
      {
        name: "Permission Schemes",
        source: this.sourceConfig.permissionSchemes,
        target: this.targetConfig.permissionSchemes,
      },
      {
        name: "Notification Schemes",
        source: this.sourceConfig.notificationSchemes,
        target: this.targetConfig.notificationSchemes,
      },
      {
        name: "Issue Security Schemes",
        source: this.sourceConfig.issueSecuritySchemes,
        target: this.targetConfig.issueSecuritySchemes,
      },
      {
        name: "Project Categories",
        source: this.sourceConfig.projectCategories,
        target: this.targetConfig.projectCategories,
      },
      {
        name: "Resolutions",
        source: this.sourceConfig.resolutions,
        target: this.targetConfig.resolutions,
      },
      {
        name: "Statuses",
        source: this.sourceConfig.statuses,
        target: this.targetConfig.statuses,
      },
    ];

    let totalSections = 0;
    let identicalSections = 0;
    let differentSections = 0;

    sections.forEach((section) => {
      if (section.source && section.target) {
        totalSections++;

        // Get the item type for this section
        const itemType = this.getItemTypeFromTitle(section.name);

        const comparison = this.compareLists(
          section.source,
          section.target,
          "name",
          "name",
          itemType,
        );

        // Apply filtering logic like in critical summary
        let hasRelevantDifferences = false;

        // Check missing items in target
        if (comparison.missingInTarget.length > 0) {
          const relevantMissing = comparison.missingInTarget.filter((item) => {
            const importance = this.categorizeItemImportance(item, itemType);

            // Apply business-critical filter
            if (
              this.options.businessCriticalOnly &&
              importance !== "critical"
            ) {
              return false;
            }

            return true;
          });

          if (relevantMissing.length > 0) {
            hasRelevantDifferences = true;
          }
        }

        // Check differences with severity filtering
        if (comparison.differences.length > 0) {
          const relevantDifferences = comparison.differences.filter((diff) => {
            // Apply business-critical filter
            if (
              this.options.businessCriticalOnly &&
              diff.importance !== "critical"
            ) {
              return false;
            }

            // Apply severity threshold filter
            if (this.options.severityThreshold) {
              const thresholdOrder = {
                low: 1,
                medium: 2,
                high: 3,
                critical: 4,
              };
              const diffOrder = thresholdOrder[diff.severity] || 0;
              const thresholdOrderVal =
                thresholdOrder[this.options.severityThreshold] || 0;

              if (diffOrder < thresholdOrderVal) {
                return false;
              }
            }

            return true;
          });

          if (relevantDifferences.length > 0) {
            hasRelevantDifferences = true;
          }
        }

        if (!hasRelevantDifferences && comparison.extraInTarget.length === 0) {
          identicalSections++;
        } else if (hasRelevantDifferences) {
          differentSections++;
          report.push(`⚠️  ${section.name}: Differences found`);
        }
      }
    });

    if (totalSections > 0) {
      report.push(`\nConfigurations compared: ${totalSections}`);
      report.push(`Identical configurations: ${identicalSections}`);
      report.push(`Different configurations: ${differentSections}`);
    }

    report.push("\n" + "=".repeat(80));
    report.push("END OF REPORT");
    report.push("=".repeat(80));

    return report.join("\n");
  }

  async run() {
    try {
      await this.fetchAllConfigurations();
      const report = this.generateComparisonReport();

      // Output to console
      console.log(report);

      // Save to file
      await this.saveReportToFile(report);
    } catch (error) {
      console.error("Error during comparison:", error.message);
      process.exit(1);
    }
  }

  // Save report to file with timestamp
  async saveReportToFile(report) {
    // Create filename with timestamp
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .substring(0, 19);
    const filename = `jira-comparison-report-${timestamp}.txt`;
    const filepath = path.resolve(this.outputDir, filename);

    try {
      // Ensure output directory exists
      await fs.mkdir(path.dirname(filepath), { recursive: true });

      await fs.writeFile(filepath, report, "utf8");
      console.log(`\n📄 Report saved to: ${filename}`);
      console.log(`📁 Full path: ${filepath}`);
    } catch (error) {
      console.error(`❌ Failed to save report to file: ${error.message}`);
    }
  }
}

// Command line interface
program
  .name("jira-config-comparator")
  .description(
    "Compare JIRA configurations between source and target instances",
  )
  .requiredOption("--source <url>", "Source JIRA instance URL")
  .requiredOption("--target <url>", "Target JIRA instance URL")
  .requiredOption("--email <email>", "Email address for authentication")
  .requiredOption("--token <token>", "API token for authentication")
  .option(
    "--output <dir>",
    "Output directory for report (default: current directory)",
    ".",
  )
  .option(
    "--severity <level>",
    "Minimum severity level to report (critical|high|medium|low)",
    "low",
  )
  .option(
    "--ignore-descriptions",
    "Ignore differences in description fields",
    false,
  )
  .option(
    "--business-critical-only",
    "Only show business-critical differences",
    false,
  )
  .option("--summary", "Show brief summary instead of full details", false)
  .addHelpText(
    "after",
    `
Examples:
  $ node jira-config-comparator.js \\
    --source https://source.atlassian.net \\
    --target https://target.atlassian.net \\
    --email user@company.com \\
    --token your-api-token

  $ node jira-config-comparator.js \\
    --source https://source.atlassian.net \\
    --target https://target.atlassian.net \\
    --email user@company.com \\
    --token your-api-token \\
    --output ./reports

  $ node jira-config-comparator.js \\
    --source https://source.atlassian.net \\
    --target https://target.atlassian.net \\
    --email user@company.com \\
    --token your-api-token \\
    --severity critical \\
    --business-critical-only

  $ node jira-config-comparator.js \\
    --source https://source.atlassian.net \\
    --target https://target.atlassian.net \\
    --email user@company.com \\
    --token your-api-token \\
    --ignore-descriptions \\
    --summary

Note: Generate API token from: https://id.atlassian.com/manage-profile/security/api-tokens
    `,
  );

program.parse();

const options = program.opts();

const comparator = new JIRAConfigComparator(
  options.source,
  options.target,
  options.email,
  options.token,
  {
    outputDir: options.output,
    severity: options.severity,
    ignoreDescriptions: options.ignoreDescriptions,
    businessCriticalOnly: options.businessCriticalOnly,
    summary: options.summary,
  },
);

comparator.run().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});
