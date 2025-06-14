import { describe, expect, it } from 'vitest';
import {
  defaultTools,
  getAllDefaultTools,
  getDefaultTools,
  toolCategories,
  getToolsByCategory,
} from '../../../tools/default-tools';

describe('default tools system', () => {
  describe('defaultTools object', () => {
    it('should contain all expected tools', () => {
      expect(defaultTools.bash).toBeDefined();
      expect(defaultTools.fileRead).toBeDefined();
      expect(defaultTools.fileEdit).toBeDefined();
      expect(defaultTools.globSearch).toBeDefined();
      expect(defaultTools.grep).toBeDefined();
      expect(defaultTools.ls).toBeDefined();
      expect(defaultTools.memoryRead).toBeDefined();
      expect(defaultTools.memoryWrite).toBeDefined();
      expect(defaultTools.think).toBeDefined();
      expect(defaultTools.agent).toBeDefined();
    });

    it('should have tools with correct structure', () => {
      Object.values(defaultTools).forEach(tool => {
        expect(tool).toBeDefined();
        expect(typeof tool).toBe('object');
      });
    });
  });

  describe('getAllDefaultTools', () => {
    it('should return array of all tools', () => {
      const tools = getAllDefaultTools();
      expect(Array.isArray(tools)).toBe(true);
      expect(tools).toHaveLength(10);
      
      // All tools should be objects (ai-sdk tool structure)
      tools.forEach(tool => {
        expect(typeof tool).toBe('object');
        expect(tool).toBeDefined();
      });
    });
  });

  describe('getDefaultTools', () => {
    it('should return specific tools by name', () => {
      const tools = getDefaultTools(['bash', 'fileRead']);
      expect(tools).toHaveLength(2);
      expect(tools[0]).toBe(defaultTools.bash);
      expect(tools[1]).toBe(defaultTools.fileRead);
    });

    it('should handle empty array', () => {
      const tools = getDefaultTools([]);
      expect(tools).toHaveLength(0);
    });

    it('should handle single tool selection', () => {
      const tools = getDefaultTools(['grep']);
      expect(tools).toHaveLength(1);
      expect(tools[0]).toBe(defaultTools.grep);
    });
  });

  describe('toolCategories', () => {
    it('should define correct categories', () => {
      expect(toolCategories.fileSystem).toBeDefined();
      expect(toolCategories.search).toBeDefined();
      expect(toolCategories.shell).toBeDefined();
      expect(toolCategories.memory).toBeDefined();
      expect(toolCategories.reasoning).toBeDefined();
      expect(toolCategories.readOnly).toBeDefined();
      expect(toolCategories.write).toBeDefined();
    });

    it('should have correct tools in fileSystem category', () => {
      const fsTools = toolCategories.fileSystem;
      expect(fsTools).toContain(defaultTools.fileRead);
      expect(fsTools).toContain(defaultTools.fileEdit);
      expect(fsTools).toContain(defaultTools.ls);
    });

    it('should have correct tools in search category', () => {
      const searchTools = toolCategories.search;
      expect(searchTools).toContain(defaultTools.globSearch);
      expect(searchTools).toContain(defaultTools.grep);
    });

    it('should have correct tools in shell category', () => {
      const shellTools = toolCategories.shell;
      expect(shellTools).toContain(defaultTools.bash);
    });

    it('should have correct tools in readOnly category', () => {
      const readOnlyTools = toolCategories.readOnly;
      expect(readOnlyTools).toContain(defaultTools.fileRead);
      expect(readOnlyTools).toContain(defaultTools.globSearch);
      expect(readOnlyTools).toContain(defaultTools.grep);
      expect(readOnlyTools).toContain(defaultTools.ls);
      expect(readOnlyTools).toContain(defaultTools.memoryRead);
      expect(readOnlyTools).toContain(defaultTools.think);
      expect(readOnlyTools).not.toContain(defaultTools.fileEdit);
      expect(readOnlyTools).not.toContain(defaultTools.bash);
    });

    it('should have correct tools in write category', () => {
      const writeTools = toolCategories.write;
      expect(writeTools).toContain(defaultTools.fileEdit);
      expect(writeTools).toContain(defaultTools.bash);
      expect(writeTools).toContain(defaultTools.memoryWrite);
      expect(writeTools).toContain(defaultTools.agent);
    });
  });

  describe('getToolsByCategory', () => {
    it('should return tools for fileSystem category', () => {
      const tools = getToolsByCategory('fileSystem');
      expect(tools).toHaveLength(3);
      expect(tools).toContain(defaultTools.fileRead);
      expect(tools).toContain(defaultTools.fileEdit);
      expect(tools).toContain(defaultTools.ls);
    });

    it('should return tools for search category', () => {
      const tools = getToolsByCategory('search');
      expect(tools).toHaveLength(2);
      expect(tools).toContain(defaultTools.globSearch);
      expect(tools).toContain(defaultTools.grep);
    });

    it('should return tools for shell category', () => {
      const tools = getToolsByCategory('shell');
      expect(tools).toHaveLength(1);
      expect(tools).toContain(defaultTools.bash);
    });

    it('should return tools for readOnly category', () => {
      const tools = getToolsByCategory('readOnly');
      expect(tools).toHaveLength(6);
      expect(tools).toContain(defaultTools.fileRead);
      expect(tools).toContain(defaultTools.globSearch);
      expect(tools).toContain(defaultTools.grep);
      expect(tools).toContain(defaultTools.ls);
      expect(tools).toContain(defaultTools.memoryRead);
      expect(tools).toContain(defaultTools.think);
    });

    it('should return tools for write category', () => {
      const tools = getToolsByCategory('write');
      expect(tools).toHaveLength(4);
      expect(tools).toContain(defaultTools.fileEdit);
      expect(tools).toContain(defaultTools.bash);
      expect(tools).toContain(defaultTools.memoryWrite);
      expect(tools).toContain(defaultTools.agent);
    });
  });

  describe('tool integration compatibility', () => {
    it('should provide tools compatible with ai-sdk', () => {
      const allTools = getAllDefaultTools();
      
      // Each tool should be an object (ai-sdk compatible)
      allTools.forEach(tool => {
        expect(typeof tool).toBe('object');
        expect(tool).not.toBe(null);
        expect(tool).toBeDefined();
      });
    });

    it('should maintain consistent tool structure across categories', () => {
      Object.values(toolCategories).forEach(categoryTools => {
        categoryTools.forEach(tool => {
          expect(typeof tool).toBe('object');
          expect(tool).toBeDefined();
        });
      });
    });
  });
});