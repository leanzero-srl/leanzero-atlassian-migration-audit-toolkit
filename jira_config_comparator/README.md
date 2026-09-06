# JIRA Configuration Comparator

A comprehensive Node.js script to compare configurations between source and target JIRA Cloud instances. This tool helps identify differences in issue types, link types, priority schemes, issue hierarchy, and sprint configuration.

## Features

- **Issue Types**: Compare all issue types and their properties
- **Issue Type Schemes**: Verify issue type scheme configurations
- **Issue Link Types**: Compare issue link types and their relationships
- **Priority Schemes**: Compare priority scheme configurations
- **Priorities**: Compare individual priority configurations
- **Issue Hierarchy**: Compare project configurations and their issue type mappings
- **Sprint Configuration**: Verify Agile sprint board settings (JIRA Software)
- **Time Tracking Configuration**: Compare time tracking and booking settings

## Prerequisites

- Node.js 14.0 or higher
- npm package manager
- JIRA Cloud API token for both instances
- Valid email address associated with the API token

## Installation

1. Clone or download this repository
2. Install dependencies:
   ```bash
   npm install
   ```

## API Token Setup

1. Log in to your Atlassian account: https://id.atlassian.com/manage-profile/security/api-tokens
2. Click "Create API token"
3. Give it a descriptive name (e.g., "JIRA Config Comparator")
4. Copy the generated token

## Usage

### Basic Usage

```bash
node jira-config-comparator.js \
  --source https://source-instance.atlassian.net \
  --target https://target-instance.atlassian.net \
  --email your.email@company.com \
  --token your-api-token
```

### Example with Real Values

```bash
node jira-config-comparator.js \
  --source https://mycompany-source.atlassian.net \
  --target https://mycompany-prod.atlassian.net \
  --email john.doe@mycompany.com \
  --token ATATT3xFfGF0... (your actual API token)
```

### Command Line Arguments

- `--source`: Source JIRA instance URL (required)
- `--target`: Target JIRA instance URL (required)
- `--email`: Email address for authentication (required)
- `--token`: API token for authentication (required)

## Output Format

The script generates a comprehensive text report that includes:

### Header Information
- Generation timestamp
- Source and target instance URLs

### Configuration Sections
For each configuration type, the report shows:
- **Missing in Target**: Items present in source but not in target
- **Extra in Target**: Items present in target but not in source
- **Configuration Differences**: Items that exist in both but have different properties
- **Item Counts**: Total number of items in each instance

### Visual Indicators
- ✅ Identical configurations
- ❌ Missing items
- ➕ Extra items
- ⚠️ Configuration differences
- 📋 Specific item details

### Summary Section
- Total configurations compared
- Number of identical configurations
- Number of different configurations

## Sample Output

```
================================================================================
JIRA CONFIGURATION COMPARISON REPORT
================================================================================
Generated: 2024-01-15 14:30:25
Source: https://source-instance.atlassian.net
Target: https://target-instance.atlassian.net
================================================================================

============================================================
ISSUE TYPES
============================================================
Source: 8 items
Target: 7 items

❌ MISSING IN TARGET (1 items):
   - Epic (ID: 10000)

⚠️  CONFIGURATION DIFFERENCES (1 items):

   📋 Bug (ID: 10001)
      description:
        Source: A problem which impairs or prevents the functions of the product.
        Target: A problem that impairs or prevents product functions.

============================================================
PRIORITY SCHEMES
============================================================
Source: 3 items
Target: 3 items
✅ Configurations are identical
```

## Configuration Details

### Issue Types
- Compares all issue types available in each instance
- Checks names, descriptions, hierarchy levels, avatars
- Identifies missing or extra issue types

### Issue Type Schemes
- Compares issue type scheme configurations
- Checks scheme names, descriptions, and mappings
- Verifies default issue types

### Issue Link Types
- Compares issue link types (blocks, duplicates, etc.)
- Checks inward/outward link descriptions
- Identifies custom link types

### Priority Schemes
- Compares priority scheme configurations
- Checks scheme names, descriptions, and priority mappings
- Verifies default priorities

### Priorities
- Compares individual priority configurations
- Checks priority names, descriptions, colors, and icons
- Identifies custom priorities

### Issue Hierarchy
- Compares project configurations
- Checks project types and issue type mappings
- Verifies priority scheme assignments

### Sprint Configuration
- Compares Agile board configurations
- Checks board names, types, and sprint settings
- Requires JIRA Software (Agile) to be installed

### Time Tracking Configuration
- Compares time tracking settings and options
- Checks working days, hours per day, and time formats
- Verifies time tracking field configurations
- Compares list configurations for time tracking display

## Troubleshooting

### Common Issues

1. **Authentication Errors**
   - Verify your API token is valid and not expired
   - Ensure the email matches the one used to generate the token
   - Check that the token has necessary permissions

2. **Connection Errors**
   - Verify the JIRA instance URLs are correct and accessible
   - Check network connectivity and firewall settings
   - Ensure your IP is not blocked by JIRA security settings

3. **Missing Data**
   - Some features (like sprint configuration) require JIRA Software
   - Check user permissions for each API endpoint
   - Verify the instances are JIRA Cloud (not Server/Data Center)

### Error Messages

- `API call failed for URL`: Network or authentication issue
- `401 Unauthorized`: Invalid credentials
- `403 Forbidden`: Insufficient permissions
- `404 Not Found`: Feature not available or endpoint doesn't exist

## Security Considerations

- **API Token Security**: Never share your API token or commit it to version control
- **Network Security**: Use HTTPS URLs only
- **Permissions**: Ensure the API token has read-only access where possible
- **Logging**: The script doesn't store any configuration data locally

## API Endpoints Used

The script uses the following JIRA REST API endpoints:

- `/rest/api/3/issuetype` - Issue types
- `/rest/api/3/issuetypescheme` - Issue type schemes
- `/rest/api/3/issueLinkType` - Issue link types
- `/rest/api/3/priorityscheme` - Priority schemes
- `/rest/api/3/priority` - Individual priorities
- `/rest/api/3/project` - Project information
- `/rest/api/3/issuetype/project` - Project issue types
- `/rest/api/3/project/{projectKey}/priorityscheme` - Project priority schemes
- `/rest/greenhopper/1.0/rapidview` - Sprint boards
- `/rest/greenhopper/1.0/rapidviewconfig/{boardId}` - Sprint board configuration
- `/rest/api/3/configuration/timetracking` - Time tracking configuration
- `/rest/api/3/configuration/timetracking/options` - Time tracking options
- `/rest/api/3/configuration/timetracking/list` - Time tracking list configuration

## Limitations

- **Read-Only**: The script only reads configurations, it doesn't modify anything
- **JIRA Cloud Only**: Designed for JIRA Cloud, may not work with Server/Data Center
- **Optional Features**: Some features (Agile boards) may not be available
- **Rate Limits**: Respects JIRA API rate limits, may be slow for large instances
- **Project Limits**: Limits project and board comparisons to avoid excessive API calls
- **Time Tracking**: Requires appropriate permissions to access time tracking configuration

## Development

### Dependencies
- `node-fetch`: HTTP client for making API requests
- `commander`: Command line argument parsing

### Running in Development
```bash
node jira-config-comparator.js --source ... --target ... --email ... --token ...
```

## Support

For issues related to:
- **Script Problems**: Check this README and troubleshoot section
- **JIRA API Issues**: Refer to [Atlassian JIRA REST API Documentation](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)
- **API Token Issues**: Manage tokens at [Atlassian Account Security](https://id.atlassian.com/manage-profile/security/api-tokens)

## License

This script is provided as-is for configuration comparison purposes. Use responsibly and in accordance with your organization's policies and Atlassian's terms of service.