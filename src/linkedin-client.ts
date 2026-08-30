import axios, { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import {
  LinkedInProfile,
  LinkedInPost,
  LinkedInConnection,
  LinkedInProfileSchema,
  LinkedInPostSchema,
  LinkedInConnectionSchema,
  LinkedInSkill,
  LinkedInPosition,
  LinkedInEducation,
  LinkedInCertification,
  LinkedInPublication,
  LinkedInLanguage,
} from './types.js';
import { Logger } from './logger.js';

/**
 * Interface for anything that can provide a valid access token.
 * This allows the client to always use a fresh token from OAuthManager
 * (with disk persistence and automatic refresh) instead of a static string.
 */
export interface TokenProvider {
  getAccessToken(): Promise<string>;
}

/**
 * Simple wrapper that turns a static token string into a TokenProvider.
 * Used when the caller provides LINKEDIN_ACCESS_TOKEN directly via env.
 */
export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly token: string) {}
  async getAccessToken(): Promise<string> {
    return this.token;
  }
}

/**
 * Transforma prompts densos de texto en directivas visuales de diseño gráfico tech de alto impacto
 */
function optimizePromptForVisualDesign(rawPrompt: string): string {
  // Limpiar artefactos de prompts que inducen al modelo a dibujar hojas de papel o mockups lejanos
  let sanitized = rawPrompt
    .replace(/cheatsheet\s*infographic/gi, 'tech infographic illustration')
    .replace(/modular grid containing clean white cards/gi, 'modern sleek geometric UI interface')
    .replace(/Panel [A-Za-z0-9\s]+:/gi, '')
    .replace(/strictly in Spanish inside the cards/gi, '')
    .replace(/Body Sections & Spanish Content.*?:\s*/gi, '')
    .replace(/\[\s*Script\s*\/.*?\]/gi, '')
    .replace(/\b(GET|POST|MERGE)\s+\/_api[^\s]+/gi, '')
    .trim();

  const coreTopic = sanitized.slice(0, 250);

  return `Full bleed modern corporate tech vector infographic illustration, theme: ${coreTopic}. Sleek cloud data architecture, glowing API network connections, vibrant digital UI dashboard elements, polished royal blue, cyber violet and emerald green accents, crisp clean tech aesthetic, 8k resolution, trending on Dribbble, professional LinkedIn banner graphic, full frame art, no picture frame, no paper mockup, no blurry document, no wall, no borders`;
}

/**
 * Genera una imagen utilizando la API de Google Gemini Imagen (Nano Banana), OpenAI o motor Nano Banana Universal
 */
export async function generateNanoBananaImage(prompt: string): Promise<Buffer> {
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.NANOBANANA_API_KEY;
  const openAiKey = process.env.OPENAI_API_KEY;
  const visualPrompt = optimizePromptForVisualDesign(prompt);

  console.log(`[Nano Banana] 🎨 Prompt visual optimizado: "${visualPrompt.slice(0, 120)}..."`);

  // 1. Intentar con modelos de Google AI Studio / Imagen
  if (geminiKey) {
    const candidateModels = [
      'imagen-3.0-generate-002',
      'imagen-3.0-generate-001',
      'imagen-3.0',
      'imagen-4.0-generate-001',
    ];

    for (const model of candidateModels) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`;
        const response = await axios.post(
          url,
          {
            instances: [{ prompt: visualPrompt }],
            parameters: {
              sampleCount: 1,
              aspectRatio: '4:5',
              outputMimeType: 'image/jpeg',
            },
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': geminiKey,
            },
            params: { key: geminiKey },
            timeout: 20000,
          }
        );

        const base64Data = response.data?.predictions?.[0]?.bytesBase64Encoded;
        if (base64Data) {
          console.log(`[Nano Banana] ✅ Imagen generada con éxito usando Google ${model}`);
          return Buffer.from(base64Data, 'base64');
        }
      } catch (err: any) {
        // Continuar con el siguiente candidato
      }
    }
  }

  // 2. Intentar con OpenAI DALL-E 3 si está configurado
  if (openAiKey) {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/images/generations',
        {
          prompt: visualPrompt,
          model: 'dall-e-3',
          n: 1,
          size: '1024x1024',
          response_format: 'b64_json',
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${openAiKey}`,
          },
          timeout: 30000,
        }
      );

      const base64Data = response.data?.data?.[0]?.b64_json;
      if (base64Data) {
        console.log('[Nano Banana] ✅ Imagen generada con éxito usando OpenAI DALL-E 3');
        return Buffer.from(base64Data, 'base64');
      }
    } catch (err: any) {
      console.warn('[Nano Banana] OpenAI endpoint no disponible, pasando a motor Nano Banana Universal...');
    }
  }

  // 3. Motor Nano Banana Universal (Flux Direct Engine - Alta resolución, sin marcos ni mockups)
  try {
    console.log('[Nano Banana] 🎨 Generando ilustración gráfica en alta definición...');
    const encodedPrompt = encodeURIComponent(visualPrompt);
    const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1080&height=1350&nologo=true&model=flux&seed=${Math.floor(Math.random() * 999999)}`;
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 35000,
      headers: {
        'User-Agent': 'LinkedIn-MCP-Server/1.4.0',
      },
    });

    if (response.data && response.data.length > 1000) {
      console.log(`[Nano Banana] ✅ Imagen generada exitosamente (${response.data.length} bytes)`);
      return Buffer.from(response.data);
    }
  } catch (err: any) {
    console.error('[Nano Banana] Error en motor universal:', err.message);
  }

  throw new Error('No se pudo generar la imagen para LinkedIn. Intenta con un prompt más breve o verifica tu conexión.');
}

export class LinkedInClient {
  private client: AxiosInstance;
  private logger: Logger;
  private tokenProvider: TokenProvider;

  constructor(tokenProvider: TokenProvider | string, logger: Logger = new Logger()) {
    this.logger = logger;
    this.tokenProvider = typeof tokenProvider === 'string'
      ? new StaticTokenProvider(tokenProvider)
      : tokenProvider;

    this.client = axios.create({
      baseURL: 'https://api.linkedin.com/v2',
      headers: {
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
    });

    // Interceptor injects a fresh Bearer token on every request
    this.client.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
      const token = await this.tokenProvider.getAccessToken();
      config.headers.Authorization = `Bearer ${token}`;
      return config;
    });
  }

  async getProfile(): Promise<LinkedInProfile> {
    try {
      this.logger.debug('Fetching LinkedIn profile');
      // Try OpenID Connect userinfo endpoint first (works with openid+profile scopes)
      try {
        const token = await this.tokenProvider.getAccessToken();
        const userinfoResponse = await axios.get('https://api.linkedin.com/v2/userinfo', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        const profile = LinkedInProfileSchema.parse({
          id: userinfoResponse.data.sub,
          firstName: userinfoResponse.data.given_name || '',
          lastName: userinfoResponse.data.family_name || '',
          headline: userinfoResponse.data.headline || '',
          profilePictureUrl: userinfoResponse.data.picture || '',
          vanityName: userinfoResponse.data.vanityName || '',
        });
        this.logger.info('Successfully fetched LinkedIn profile via userinfo');
        return profile;
      } catch (_userinfoError) {
        this.logger.debug('userinfo endpoint failed, trying /me endpoint');
        // Fall back to legacy /me endpoint (requires r_liteprofile scope)
        const response = await this.client.get('/me');
        const profile = LinkedInProfileSchema.parse({
          id: response.data.id,
          firstName: response.data.localizedFirstName || response.data.firstName?.localized?.en_US || '',
          lastName: response.data.localizedLastName || response.data.lastName?.localized?.en_US || '',
          headline: response.data.headline,
          profilePictureUrl: response.data.profilePicture,
          vanityName: response.data.vanityName,
        });
        this.logger.info('Successfully fetched LinkedIn profile via /me');
        return profile;
      }
    } catch (error) {
      this.logger.error('Error fetching LinkedIn profile', error);
      throw new Error(`Failed to fetch LinkedIn profile: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getPosts(limit: number = 10): Promise<LinkedInPost[]> {
    try {
      this.logger.debug(`Fetching LinkedIn posts (limit: ${limit})`);
      const response = await this.client.get('/ugcPosts', {
        params: {
          q: 'authors',
          authors: 'urn:li:person:me',
          count: limit,
        },
      });

      const posts = response.data.elements?.map((post: any) => {
        return LinkedInPostSchema.parse({
          id: post.id,
          author: post.author,
          text: post.specificContent?.['com.linkedin.ugc.ShareContent']?.shareCommentary?.text || '',
          createdAt: new Date(post.created?.time || Date.now()).toISOString(),
          likeCount: post.likesSummary?.totalLikes || 0,
          commentCount: post.commentsSummary?.totalComments || 0,
          shareCount: post.sharesSummary?.totalShares || 0,
        });
      }) || [];

      this.logger.info(`Successfully fetched ${posts.length} LinkedIn posts`);
      return posts;
    } catch (error) {
      this.logger.error('Error fetching LinkedIn posts', error);
      throw new Error(`Failed to fetch LinkedIn posts: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getConnections(limit: number = 50): Promise<LinkedInConnection[]> {
    try {
      this.logger.debug(`Fetching LinkedIn connections (limit: ${limit})`);
      const response = await this.client.get('/connections', {
        params: {
          q: 'viewer',
          start: 0,
          count: limit,
        },
      });

      const connections = response.data.elements?.map((conn: any) => {
        return LinkedInConnectionSchema.parse({
          id: conn.to || conn.id || '',
          firstName: conn.firstName?.localized?.en_US || '',
          lastName: conn.lastName?.localized?.en_US || '',
          headline: conn.headline,
          connectedAt: conn.createdAt ? new Date(conn.createdAt).toISOString() : undefined,
        });
      }) || [];

      this.logger.info(`Successfully fetched ${connections.length} LinkedIn connections`);
      return connections;
    } catch (error) {
      this.logger.error('Error fetching LinkedIn connections', error);
      throw new Error(`Failed to fetch LinkedIn connections: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async uploadImage(imageData: Buffer | string, ownerUrn?: string): Promise<string> {
    try {
      this.logger.debug('Registering image upload on LinkedIn');
      let owner = ownerUrn;
      if (!owner) {
        const profile = await this.getProfile();
        owner = `urn:li:person:${profile.id}`;
      }

      const token = await this.tokenProvider.getAccessToken();

      // 1. Registrar el upload del asset
      const registerResponse = await this.client.post('/assets?action=registerUpload', {
        registerUploadRequest: {
          recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
          owner,
          supportedUploadMechanism: ['SYNCHRONOUS_UPLOAD'],
        },
      });

      const uploadUrl = registerResponse.data.value?.uploadMechanism?.['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest']?.uploadUrl;
      const asset = registerResponse.data.value?.asset;

      if (!uploadUrl || !asset) {
        throw new Error('Failed to obtain LinkedIn upload URL or asset URN');
      }

      // 2. Obtener el buffer de la imagen
      let buffer: Buffer;
      let contentType = 'image/jpeg';

      if (Buffer.isBuffer(imageData)) {
        buffer = imageData;
      } else if (typeof imageData === 'string' && (imageData.startsWith('http://') || imageData.startsWith('https://'))) {
        this.logger.debug(`Downloading image from URL: ${imageData}`);
        const dlResponse = await axios.get(imageData, { responseType: 'arraybuffer' });
        buffer = Buffer.from(dlResponse.data);
        contentType = String(dlResponse.headers['content-type'] || 'image/jpeg');
      } else if (typeof imageData === 'string' && imageData.startsWith('data:')) {
        const matches = imageData.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          contentType = matches[1];
          buffer = Buffer.from(matches[2], 'base64');
        } else {
          buffer = Buffer.from(imageData, 'base64');
        }
      } else if (typeof imageData === 'string') {
        buffer = Buffer.from(imageData, 'base64');
      } else {
        throw new Error('Unsupported image data format');
      }

      // 3. Subir el binario de la imagen al uploadUrl de LinkedIn
      this.logger.debug(`Uploading image binary to LinkedIn (${buffer.length} bytes)`);
      await axios.put(uploadUrl, buffer, {
        headers: {
          'Content-Type': contentType,
          Authorization: `Bearer ${token}`,
        },
      });

      this.logger.info(`Successfully uploaded image to LinkedIn. Asset URN: ${asset}`);
      return asset;
    } catch (error) {
      this.logger.error('Error uploading image to LinkedIn', error);
      throw new Error(`Failed to upload image to LinkedIn: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async sharePost(options: string | {
    text: string;
    imageUrl?: string;
    imageBuffer?: Buffer;
    imagePrompt?: string;
    articleUrl?: string;
    title?: string;
    description?: string;
  }): Promise<{ id: string; url: string; assetUrn?: string }> {
    try {
      const text = typeof options === 'string' ? options : options.text;
      const imageUrl = typeof options === 'object' ? options.imageUrl : undefined;
      const imageBuffer = typeof options === 'object' ? options.imageBuffer : undefined;
      const imagePrompt = typeof options === 'object' ? options.imagePrompt : undefined;
      const articleUrl = typeof options === 'object' ? options.articleUrl : undefined;
      const title = typeof options === 'object' ? options.title : undefined;
      const description = typeof options === 'object' ? options.description : undefined;

      this.logger.debug('Creating LinkedIn post with enhanced media support');
      const profile = await this.getProfile();
      const authorUrn = `urn:li:person:${profile.id}`;

      let shareMediaCategory = 'NONE';
      const mediaList: any[] = [];
      let attachedAssetUrn: string | undefined;

      // 1. Caso Imagen generada con Nano Banana / Gemini Imagen si viene imagePrompt
      let effectiveImageSource = imageUrl || imageBuffer;
      if (imagePrompt && !effectiveImageSource) {
        this.logger.info(`Generating image with Nano Banana / Imagen for prompt: "${imagePrompt}"`);
        effectiveImageSource = await generateNanoBananaImage(imagePrompt);
      }

      // 2. Caso Imagen (URL o Buffer)
      if (effectiveImageSource) {
        const assetUrn = await this.uploadImage(effectiveImageSource, authorUrn);
        attachedAssetUrn = assetUrn;
        shareMediaCategory = 'IMAGE';
        mediaList.push({
          status: 'READY',
          description: {
            text: description || title || 'Image',
          },
          media: assetUrn,
          title: {
            text: title || 'Image',
          },
        });
      } else if (articleUrl) {
        // 3. Caso Artículo / Enlace enriquecido
        shareMediaCategory = 'ARTICLE';
        mediaList.push({
          status: 'READY',
          originalUrl: articleUrl,
          description: description ? { text: description } : undefined,
          title: title ? { text: title } : undefined,
        });
      }

      const postBody: any = {
        author: authorUrn,
        lifecycleState: 'PUBLISHED',
        specificContent: {
          'com.linkedin.ugc.ShareContent': {
            shareCommentary: {
              text,
            },
            shareMediaCategory,
            ...(mediaList.length > 0 ? { media: mediaList } : {}),
          },
        },
        visibility: {
          'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
        },
      };

      const response = await this.client.post('/ugcPosts', postBody);
      const postId = response.data.id;
      const postUrl = `https://www.linkedin.com/feed/update/${postId}`;

      this.logger.info(`Successfully created LinkedIn post: ${postId} (media: ${shareMediaCategory})`);
      return { id: postId, url: postUrl, assetUrn: attachedAssetUrn };
    } catch (error) {
      this.logger.error('Error creating LinkedIn post', error);
      throw new Error(`Failed to create LinkedIn post: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async searchPeople(keywords: string, limit: number = 10): Promise<LinkedInConnection[]> {
    try {
      this.logger.debug(`Searching LinkedIn people with keywords: ${keywords}`);
      const response = await this.client.get('/search', {
        params: {
          q: 'people',
          keywords,
          count: limit,
        },
      });

      const people = response.data.elements?.map((person: any) => {
        return LinkedInConnectionSchema.parse({
          id: person.id || '',
          firstName: person.firstName?.localized?.en_US || '',
          lastName: person.lastName?.localized?.en_US || '',
          headline: person.headline,
        });
      }) || [];

      this.logger.info(`Successfully found ${people.length} people matching: ${keywords}`);
      return people;
    } catch (error) {
      this.logger.error('Error searching LinkedIn people', error);
      throw new Error(`Failed to search LinkedIn people: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Profile Management Methods

  async addSkill(skill: LinkedInSkill): Promise<{ id: string }> {
    try {
      this.logger.debug(`Adding skill: ${skill.name}`);
      const profile = await this.getProfile();
      const response = await this.client.post(`/people/(id:${profile.id})/skills`, {
        name: {
          locale: { language: 'en', country: 'US' },
          value: skill.name,
        },
      });

      const skillId = response.headers['x-linkedin-id'] || response.data.id;
      this.logger.info(`Successfully added skill: ${skill.name} (${skillId})`);
      return { id: skillId };
    } catch (error) {
      this.logger.error('Error adding skill', error);
      throw new Error(`Failed to add skill: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async deleteSkill(skillId: string): Promise<void> {
    try {
      this.logger.debug(`Deleting skill: ${skillId}`);
      const profile = await this.getProfile();
      await this.client.delete(`/people/(id:${profile.id})/skills/${skillId}`);
      this.logger.info(`Successfully deleted skill: ${skillId}`);
    } catch (error) {
      this.logger.error('Error deleting skill', error);
      throw new Error(`Failed to delete skill: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async addPosition(position: LinkedInPosition): Promise<{ id: string }> {
    try {
      this.logger.debug(`Adding position: ${position.title} at ${position.company}`);
      const profile = await this.getProfile();

      const payload: any = {
        title: {
          locale: { language: 'en', country: 'US' },
          value: position.title,
        },
        company: {
          locale: { language: 'en', country: 'US' },
          value: position.company,
        },
        timePeriod: {
          startDate: {
            year: position.startDate.year,
            ...(position.startDate.month && { month: position.startDate.month }),
          },
        },
      };

      if (position.description) {
        payload.description = {
          locale: { language: 'en', country: 'US' },
          value: position.description,
        };
      }

      if (position.endDate && !position.current) {
        payload.timePeriod.endDate = {
          year: position.endDate.year,
          ...(position.endDate.month && { month: position.endDate.month }),
        };
      }

      const response = await this.client.post(`/people/(id:${profile.id})/positions`, payload);

      const positionId = response.headers['x-linkedin-id'] || response.data.id;
      this.logger.info(`Successfully added position: ${position.title} (${positionId})`);
      return { id: positionId };
    } catch (error) {
      this.logger.error('Error adding position', error);
      throw new Error(`Failed to add position: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async updatePosition(positionId: string, position: Partial<LinkedInPosition>): Promise<void> {
    try {
      this.logger.debug(`Updating position: ${positionId}`);
      const profile = await this.getProfile();

      const payload: any = {};

      if (position.title) {
        payload.title = {
          locale: { language: 'en', country: 'US' },
          value: position.title,
        };
      }

      if (position.company) {
        payload.company = {
          locale: { language: 'en', country: 'US' },
          value: position.company,
        };
      }

      if (position.description) {
        payload.description = {
          locale: { language: 'en', country: 'US' },
          value: position.description,
        };
      }

      if (position.startDate || position.endDate) {
        payload.timePeriod = {};
        if (position.startDate) {
          payload.timePeriod.startDate = {
            year: position.startDate.year,
            ...(position.startDate.month && { month: position.startDate.month }),
          };
        }
        if (position.endDate && !position.current) {
          payload.timePeriod.endDate = {
            year: position.endDate.year,
            ...(position.endDate.month && { month: position.endDate.month }),
          };
        }
      }

      await this.client.put(`/people/(id:${profile.id})/positions/${positionId}`, payload);
      this.logger.info(`Successfully updated position: ${positionId}`);
    } catch (error) {
      this.logger.error('Error updating position', error);
      throw new Error(`Failed to update position: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async deletePosition(positionId: string): Promise<void> {
    try {
      this.logger.debug(`Deleting position: ${positionId}`);
      const profile = await this.getProfile();
      await this.client.delete(`/people/(id:${profile.id})/positions/${positionId}`);
      this.logger.info(`Successfully deleted position: ${positionId}`);
    } catch (error) {
      this.logger.error('Error deleting position', error);
      throw new Error(`Failed to delete position: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async addEducation(education: LinkedInEducation): Promise<{ id: string }> {
    try {
      this.logger.debug(`Adding education: ${education.schoolName}`);
      const profile = await this.getProfile();

      const payload: any = {
        schoolName: {
          locale: { language: 'en', country: 'US' },
          value: education.schoolName,
        },
      };

      if (education.degree) {
        payload.degreeName = {
          locale: { language: 'en', country: 'US' },
          value: education.degree,
        };
      }

      if (education.fieldOfStudy) {
        payload.fieldOfStudy = {
          locale: { language: 'en', country: 'US' },
          value: education.fieldOfStudy,
        };
      }

      if (education.startDate || education.endDate) {
        payload.timePeriod = {};
        if (education.startDate) {
          payload.timePeriod.startDate = {
            year: education.startDate.year,
            ...(education.startDate.month && { month: education.startDate.month }),
          };
        }
        if (education.endDate) {
          payload.timePeriod.endDate = {
            year: education.endDate.year,
            ...(education.endDate.month && { month: education.endDate.month }),
          };
        }
      }

      if (education.grade) {
        payload.grade = {
          locale: { language: 'en', country: 'US' },
          value: education.grade,
        };
      }

      if (education.activities) {
        payload.activities = {
          locale: { language: 'en', country: 'US' },
          value: education.activities,
        };
      }

      const response = await this.client.post(`/people/(id:${profile.id})/educations`, payload);

      const educationId = response.headers['x-linkedin-id'] || response.data.id;
      this.logger.info(`Successfully added education: ${education.schoolName} (${educationId})`);
      return { id: educationId };
    } catch (error) {
      this.logger.error('Error adding education', error);
      throw new Error(`Failed to add education: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async deleteEducation(educationId: string): Promise<void> {
    try {
      this.logger.debug(`Deleting education: ${educationId}`);
      const profile = await this.getProfile();
      await this.client.delete(`/people/(id:${profile.id})/educations/${educationId}`);
      this.logger.info(`Successfully deleted education: ${educationId}`);
    } catch (error) {
      this.logger.error('Error deleting education', error);
      throw new Error(`Failed to delete education: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async addCertification(certification: LinkedInCertification): Promise<{ id: string }> {
    try {
      this.logger.debug(`Adding certification: ${certification.name}`);
      const profile = await this.getProfile();

      const payload: any = {
        name: {
          locale: { language: 'en', country: 'US' },
          value: certification.name,
        },
        authority: {
          locale: { language: 'en', country: 'US' },
          value: certification.authority,
        },
      };

      if (certification.licenseNumber) {
        payload.licenseNumber = {
          locale: { language: 'en', country: 'US' },
          value: certification.licenseNumber,
        };
      }

      if (certification.startDate || certification.endDate) {
        payload.timePeriod = {};
        if (certification.startDate) {
          payload.timePeriod.startDate = {
            year: certification.startDate.year,
            ...(certification.startDate.month && { month: certification.startDate.month }),
          };
        }
        if (certification.endDate) {
          payload.timePeriod.endDate = {
            year: certification.endDate.year,
            ...(certification.endDate.month && { month: certification.endDate.month }),
          };
        }
      }

      if (certification.url) {
        payload.url = certification.url;
      }

      const response = await this.client.post(`/people/(id:${profile.id})/certifications`, payload);

      const certId = response.headers['x-linkedin-id'] || response.data.id;
      this.logger.info(`Successfully added certification: ${certification.name} (${certId})`);
      return { id: certId };
    } catch (error) {
      this.logger.error('Error adding certification', error);
      throw new Error(`Failed to add certification: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async deleteCertification(certificationId: string): Promise<void> {
    try {
      this.logger.debug(`Deleting certification: ${certificationId}`);
      const profile = await this.getProfile();
      await this.client.delete(`/people/(id:${profile.id})/certifications/${certificationId}`);
      this.logger.info(`Successfully deleted certification: ${certificationId}`);
    } catch (error) {
      this.logger.error('Error deleting certification', error);
      throw new Error(`Failed to delete certification: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async addPublication(publication: LinkedInPublication): Promise<{ id: string }> {
    try {
      this.logger.debug(`Adding publication: ${publication.name}`);
      const profile = await this.getProfile();

      const payload: any = {
        name: {
          locale: { language: 'en', country: 'US' },
          value: publication.name,
        },
      };

      if (publication.publisher) {
        payload.publisher = {
          locale: { language: 'en', country: 'US' },
          value: publication.publisher,
        };
      }

      if (publication.description) {
        payload.description = {
          locale: { language: 'en', country: 'US' },
          value: publication.description,
        };
      }

      if (publication.date) {
        payload.date = {
          year: publication.date.year,
          ...(publication.date.month && { month: publication.date.month }),
          ...(publication.date.day && { day: publication.date.day }),
        };
      }

      if (publication.url) {
        payload.url = publication.url;
      }

      const response = await this.client.post(`/people/(id:${profile.id})/publications`, payload);

      const pubId = response.headers['x-linkedin-id'] || response.data.id;
      this.logger.info(`Successfully added publication: ${publication.name} (${pubId})`);
      return { id: pubId };
    } catch (error) {
      this.logger.error('Error adding publication', error);
      throw new Error(`Failed to add publication: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async deletePublication(publicationId: string): Promise<void> {
    try {
      this.logger.debug(`Deleting publication: ${publicationId}`);
      const profile = await this.getProfile();
      await this.client.delete(`/people/(id:${profile.id})/publications/${publicationId}`);
      this.logger.info(`Successfully deleted publication: ${publicationId}`);
    } catch (error) {
      this.logger.error('Error deleting publication', error);
      throw new Error(`Failed to delete publication: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async addLanguage(language: LinkedInLanguage): Promise<{ id: string }> {
    try {
      this.logger.debug(`Adding language: ${language.name}`);
      const profile = await this.getProfile();

      const payload: any = {
        name: {
          locale: { language: 'en', country: 'US' },
          value: language.name,
        },
      };

      if (language.proficiency) {
        payload.proficiency = language.proficiency;
      }

      const response = await this.client.post(`/people/(id:${profile.id})/languages`, payload);

      const langId = response.headers['x-linkedin-id'] || response.data.id;
      this.logger.info(`Successfully added language: ${language.name} (${langId})`);
      return { id: langId };
    } catch (error) {
      this.logger.error('Error adding language', error);
      throw new Error(`Failed to add language: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async deleteLanguage(languageId: string): Promise<void> {
    try {
      this.logger.debug(`Deleting language: ${languageId}`);
      const profile = await this.getProfile();
      await this.client.delete(`/people/(id:${profile.id})/languages/${languageId}`);
      this.logger.info(`Successfully deleted language: ${languageId}`);
    } catch (error) {
      this.logger.error('Error deleting language', error);
      throw new Error(`Failed to delete language: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
