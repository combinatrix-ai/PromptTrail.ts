import { createTool } from '../packages/core/src';

const t = createTool({
  name: 'weather_forecast',
  description: 'Get the weather forecast for a given location',
  schema: {
    properties: {
      location: {
        type: 'string',
        description: 'The location to get the weather forecast for',
      },
      date: {
        type: 'string',
        description:
          'The date to get the weather forecast for. Defaults to today',
      },
    },
    required: ['location'],
  },
  execute: async () => {
    // Get the weather forecast
    const forecast = 'sunny';
    return forecast;
  },
});

export default t;
