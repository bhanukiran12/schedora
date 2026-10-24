export async function loadStartupConfig(read, pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const config = await read();
      if (!config || typeof config.productDomain !== 'string') throw Object.assign(new Error('Invalid service response'), { status: 502 });
      return config;
    } catch (error) {
      if (attempt === 2 || ![0, 502, 503, 504].includes(error.status)) throw error;
      await pause(1000 * (attempt + 1));
    }
  }
}
