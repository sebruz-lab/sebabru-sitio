document.addEventListener('DOMContentLoaded', () => {

    // Easing cúbico (el mismo que usa /escuela/abierta) para que el scroll
    // de la home se sienta con el mismo tipo de suavizado, en vez de un
    // mapeo lineal 1:1 con el scroll.
    function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

    // 1 + 5 + RECORRIDO ESPACIAL. UN SOLO MOTOR DE SCROLL: parallax del
    // fondo + (si existe #escena-track) el recorrido no lineal de la home,
    // con el mismo mecanismo de cámara que /escuela/abierta — un solo rAF
    // compartido en vez de un listener de scroll por efecto.
    const fixedBackground = document.getElementById('fixed-background');
    const parallaxSpeed = 0.4;
    let scrollTicking = false;

    const escenaTrack = document.getElementById('escena-track');
    const universo = document.getElementById('universo');
    const capaLejana = escenaTrack ? escenaTrack.querySelector('.capa-lejana') : null;
    const BLOQUES = escenaTrack ? Array.prototype.slice.call(escenaTrack.querySelectorAll('.bloque')) : [];
    const POS = BLOQUES.map(b => [parseFloat(b.dataset.x) || 0, parseFloat(b.dataset.y) || 0]);
    const NB = BLOQUES.length;
    const PARALLAX_MAPA = 0.45;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Resistencia del scroll: en vez de saltar directo a la posición que
    // marca el scroll, el recorrido persigue ese punto con un poco de
    // "peso" (lerp) — pero sobre el ÚNICO número que gobierna todo lo
    // demás (seg), no sobre la posición 2D de la cámara. Así la cámara,
    // la opacidad de los bloques y el deslizamiento interno de cada uno
    // quedan siempre sincronizados entre sí (si se amortiguaban por
    // separado, el deslizamiento terminaba antes de que el bloque
    // llegara a verse — la cámara todavía la estaba "alcanzando").
    //
    // La resistencia se mide en TIEMPO (tau, en ms), no en frames. Antes era
    // un factor fijo por frame (0.035) y eso la ataba al framerate: los
    // ~480ms de peso que se sienten a 60fps se volvian ~960ms a 30fps. O sea
    // que el celular de gama media no sufria la misma amortiguacion que la
    // compu, sufria el doble, justo donde menos se la puede pagar: la camara
    // llegaba tan tarde que se lee como que el sitio va lento. Con
    // k = 1 - e^(-dt/tau) el peso en tiempo real es el mismo en todos los
    // equipos. tau mas grande = mas pesado. Por eso el recorrido tiene su
    // propio loop de rAF, que sigue animando con el scroll parado hasta
    // alcanzar el objetivo (y despues se duerme, mas abajo).
    let TAU_GAMA_ALTA = 300;    // ms, equipo que sostiene ~60fps
    const TAU_GAMA_BAJA = 110;  // ms, equipo que apenas llega a ~30fps
    // Para probar otro valor en el propio celular sin un deploy por
    // iteracion: sebabru.com/?tau=250
    const TAU_URL = parseFloat(new URLSearchParams(location.search).get('tau'));
    if (TAU_URL >= 60 && TAU_URL <= 1200) TAU_GAMA_ALTA = TAU_URL;
    const DT_60FPS = 1000 / 60;
    // Lo que le cuesta a ESTE equipo dibujar un frame, promediado mientras
    // la camara se mueve. Arranca con una pista estatica (4 nucleos o menos
    // es gama media para abajo) para que el primer gesto ya use un tau
    // razonable, en vez de venir pesado mientras el promedio aprende.
    let dtMedio = (navigator.hardwareConcurrency || 8) <= 4 ? 26 : DT_60FPS;
    const TAU_APRENDIZAJE = 300;  // ms que tarda dtMedio en seguir al equipo
    let tau = 0;           // sale de dtMedio en cada frame
    let ultimoFrame = 0;   // 0 = el loop venia dormido
    let segActual = null;

    function clamp01(v) { return Math.max(0, Math.min(1, v)); }

    // La resistencia que corresponde a un costo de frame: 18ms (~55fps) es
    // gama alta y se lleva toda la amortiguacion; 34ms (~29fps) es gama baja
    // y va casi directo al dedo, porque ahi cualquier peso extra se siente
    // como atraso. En el medio, interpolado.
    function tauPara(dt) {
        const gama = clamp01((dt - 18) / (34 - 18));
        return TAU_GAMA_ALTA + (TAU_GAMA_BAJA - TAU_GAMA_ALTA) * gama;
    }

    // Mueve la cámara del recorrido y le da a cada bloque su opacidad/escala
    // según qué tan cerca está — y, si el bloque es de los que ya traían
    // animación por --scroll-progress (imagen+texto, glifos de Neptuno/
    // Júpiter, péndulos de Mercurio/Sol), le pasa un progreso local que
    // sube de 0 a 1 a medida que la cámara "llega" a ese bloque y se queda
    // en 1 al pasarlo de largo.
    // Devuelve true cuando la camara ya llego a donde la manda el scroll y
    // no queda nada por animar, para que el loop se pueda dormir.
    function frameRecorrido() {
        if (!escenaTrack || NB === 0) return true;
        const scrollable = escenaTrack.offsetHeight - window.innerHeight;
        const p = scrollable > 0 ? clamp01(-escenaTrack.getBoundingClientRect().top / scrollable) : 0;
        const segCrudo = p * (NB - 1);

        if (segActual === null) segActual = segCrudo;

        // dt real de este frame, clampeado: un frame perdido no tiene que
        // producir un salto de camara.
        const ahora = performance.now();
        const dt = ultimoFrame ? Math.min(ahora - ultimoFrame, 64) : DT_60FPS;
        // El primer frame despues de dormir no cuenta para el promedio: su
        // dt es el rato que el loop estuvo quieto, no lo que cuesta dibujar.
        // El promedio aprende en TIEMPO, igual que la camara: con un factor
        // por frame, el equipo lento (justo el que menos frames da) tardaba
        // medio segundo largo en reconocerse como lento, o sea despues del
        // gesto. Asi conoce al equipo dentro del primer gesto, y como
        // dtMedio ya viene suavizado, el tau sale directo de el.
        if (ultimoFrame) dtMedio += (dt - dtMedio) * (1 - Math.exp(-dt / TAU_APRENDIZAJE));
        ultimoFrame = ahora;
        tau = tauPara(dtMedio);

        // Si falta menos de medio milesimo de bloque, plantamos el valor
        // exacto: la amortiguacion nunca llega sola, y ese resto es
        // invisible pero mantendria el rAF corriendo para siempre.
        const llego = Math.abs(segCrudo - segActual) < 0.0005;
        segActual = llego ? segCrudo : segActual + (segCrudo - segActual) * (1 - Math.exp(-dt / tau));
        const seg = segActual;

        const i = Math.floor(seg), f = seg - i, j = Math.min(i + 1, NB - 1);
        const fe = easeInOut(f);
        const camX = POS[i][0] + (POS[j][0] - POS[i][0]) * fe;
        const camY = POS[i][1] + (POS[j][1] - POS[i][1]) * fe;

        universo.style.transform = `translate(${(-camX).toFixed(1)}px,${(-camY).toFixed(1)}px)`;
        if (capaLejana) {
            capaLejana.style.transform = `translate(${(-camX * PARALLAX_MAPA).toFixed(1)}px,${(-camY * PARALLAX_MAPA).toFixed(1)}px)`;
        }

        for (let k = 0; k < NB; k++) {
            const dx = camX - POS[k][0], dy = camY - POS[k][1];
            const d = Math.sqrt(dx * dx + dy * dy);
            // Pequeña meseta alrededor del 100% de cercanía: el bloque se
            // sostiene un cachito en su aparición plena antes de empezar a
            // desvanecerse (al llegar y al irse), en vez de caer apenas la
            // cámara se despega del punto exacto.
            const D_MESETA = 60;
            const vis = clamp01(1 - Math.max(0, d - D_MESETA) / 470);
            const b = BLOQUES[k];
            b.style.opacity = vis;
            b.style.visibility = vis > 0.03 ? 'visible' : 'hidden';
            b.style.transform = `translate(-50%,-50%) translate(${POS[k][0]}px,${POS[k][1]}px) scale(${(0.92 + 0.08 * vis).toFixed(3)})`;
            b.style.pointerEvents = vis > 0.6 ? 'auto' : 'none';

            if (b.classList.contains('efecto-shrink-container')) {
                const esGlifo = b.classList.contains('glifo-section') ||
                    b.classList.contains('seccion-mercurio-animada') ||
                    b.classList.contains('seccion-sol-animada');

                if (esGlifo) {
                    // Neptuno/Júpiter/Mercurio/Sol: fórmula original, sin
                    // tocar — es la que andaba bien. A propósito NO
                    // comparte código con la rama de abajo, para que un
                    // futuro ajuste ahí nunca pueda volver a afectar esto.
                    // Júpiter es el último bloque: la cámara se frena en seg = NB-1,
                    // así que con la ventana normal nunca pasaba del 50% y el
                    // glifo quedaba sin cerrar. Ahí la ventana termina en k.
                    const ultimo = k === NB - 1;
                    const localGlifo = ultimo
                        ? clamp01((seg - (k - 0.6)) / 0.6)
                        : clamp01((seg - (k - 0.6)) / 1.2);
                    b.style.setProperty('--scroll-progress', easeInOut(localGlifo));
                } else {
                    // Imagen+texto en DESKTOP (--scroll-progress): arranca
                    // más tarde (dwell: primero "para" en la imagen ya
                    // enfocada) pero SIEMPRE termina exactamente al llegar
                    // (seg === k, el pico de opacidad del bloque) — nunca
                    // más tarde, porque si el 100% se alcanza ya de
                    // camino al siguiente bloque, el texto nunca llega a
                    // verse del todo opaco (el bloque ya se está yendo).
                    const DWELL_IMG_TEXTO = 0.6; // fracción del acercamiento parado en la imagen
                    const ventanaImgTexto = 1 - DWELL_IMG_TEXTO;
                    const localImgTexto = clamp01((seg - (k - ventanaImgTexto)) / ventanaImgTexto);
                    b.style.setProperty('--scroll-progress', easeInOut(localImgTexto));

                    // Imagen+texto en MOBILE (--progreso-mobile): mismo
                    // patrón de dwell que arriba (arranca tarde, termina
                    // justo al enfocar) pero con su propia ventana, mucho
                    // más angosta — la imagen se achica recién cuando la
                    // cámara está prácticamente encima del bloque.
                    const DWELL_MOBILE = 0.3; // fracción del acercamiento parado en la imagen (mobile)
                    const ventanaMobile = 1 - DWELL_MOBILE;
                    const localMobile = clamp01((seg - (k - ventanaMobile)) / ventanaMobile);
                    b.style.setProperty('--progreso-mobile', localMobile * localMobile * (3 - 2 * localMobile));
                }
            }
        }

        return llego;
    }

    function updateScrollEffects() {
        const scrollY = window.pageYOffset;

        if (fixedBackground) {
            fixedBackground.style.transform = `translateY(${scrollY * parallaxSpeed}px)`;
        }

        scrollTicking = false;
    }

    window.addEventListener('scroll', () => {
        if (!scrollTicking) {
            window.requestAnimationFrame(updateScrollEffects);
            scrollTicking = true;
        }
    }, { passive: true });

    updateScrollEffects(); // primer paint: que el fondo ya esté bien sin esperar el primer scroll

    // El recorrido corre en su propio loop continuo (no solo al scrollear):
    // la "resistencia" necesita seguir animando unos frames más después de
    // que el scroll se detiene, para terminar de alcanzar la posición.
    //
    // Pero DUERME cuando la camara ya llego: antes el rAF seguia corriendo
    // aunque la pagina estuviera quieta, o sea que el telefono repintaba 60
    // veces por segundo sin que cambiara nada (bateria y calor en gama
    // media). Ahora el loop se corta al llegar y lo despierta el scroll.
    let recorridoDespierto = false;
    function despertarRecorrido() {
        if (!escenaTrack || reduce || recorridoDespierto) return;
        recorridoDespierto = true;
        ultimoFrame = 0;  // el rato dormido no es el costo de un frame
        (function loopRecorrido() {
            if (frameRecorrido()) { recorridoDespierto = false; return; }
            requestAnimationFrame(loopRecorrido);
        })();
    }

    if (escenaTrack && !reduce) {
        window.addEventListener('scroll', despertarRecorrido, { passive: true });
        window.addEventListener('resize', despertarRecorrido);
        window.addEventListener('orientationchange', despertarRecorrido);
        // Las imagenes que terminan de cargar despues del DOM pueden cambiar
        // el alto del track: recalculamos una vez mas con todo cargado.
        window.addEventListener('load', despertarRecorrido);
        despertarRecorrido(); // primer paint
    }

    // Con el movimiento reducido activado, la cámara no corre — en vez de
    // dejar los bloques fijos en su primer instante (imagen tapando todo,
    // texto en 0%), volvemos al mecanismo lineal de siempre: cada sección
    // es su propio sticky y --scroll-progress se calcula por la posición
    // de ESA sección en la página (no por la cámara). El CSS que recibe
    // esto ya estaba ahí desde antes del recorrido espacial — nunca se
    // tocó, solo quedaba tapado por los estilos del .bloque.
    if (reduce) {
        let tickingReduce = false;
        function frameReduce() {
            document.querySelectorAll('.efecto-shrink-container').forEach((container) => {
                const rect = container.getBoundingClientRect();
                let progress = -rect.top / (rect.height - window.innerHeight);
                progress = clamp01(progress);
                container.style.setProperty('--scroll-progress', progress);
                // En ventanas angostas (<=768px) el CSS achica la imagen con
                // --progreso-mobile, no con --scroll-progress.
                container.style.setProperty('--progreso-mobile', progress * progress * (3 - 2 * progress));
            });
            tickingReduce = false;
        }
        window.addEventListener('scroll', () => {
            if (!tickingReduce) {
                window.requestAnimationFrame(frameReduce);
                tickingReduce = true;
            }
        }, { passive: true });
        frameReduce(); // primer paint
    }

    // Lleva la cámara del recorrido a un bloque puntual (usado por los
    // links internos de más abajo). Devuelve false si el id no es un
    // bloque del recorrido, para que el link siga su comportamiento normal.
    function goToBloque(id, inmediato) {
        // Con movimiento reducido no hay camara: el link sigue con el
        // scroll comun hasta la seccion.
        if (!escenaTrack || reduce) return false;
        const idx = BLOQUES.findIndex(b => b.id === id);
        if (idx < 0) return false;
        const scrollable = escenaTrack.offsetHeight - window.innerHeight;
        const destino = escenaTrack.offsetTop + scrollable * (idx / (NB - 1));
        if (inmediato) {
            // Llegando con un #hash no hay nada que animar: la camara se
            // planta en el bloque. Sin plantar tambien segActual, la
            // resistencia del recorrido arranca en 0 y la persona ve el
            // viaje entero pasar solo durante varios segundos.
            segActual = idx;
            window.scrollTo({ top: destino, behavior: 'auto' });
            frameRecorrido();
        } else {
            window.scrollTo({ top: destino, behavior: 'smooth' });
            despertarRecorrido();
        }
        return true;
    }

    // Que ancla de ESTA pagina apunta un link, o '' si apunta a otra parte.
    //
    // No alcanza con mirar si el href empieza con '#': el menu de la home
    // usa URLs absolutas (https://sebabru.com/#podcast), asi que sin esto
    // el navegador recarga la pagina entera en vez de scrollear — y al
    // recargar cae en el lugar equivocado, porque las secciones del
    // recorrido son bloques posicionados a mano.
    function anclaDeEstaPagina(link) {
        const href = link.getAttribute('href');
        if (!href) return '';
        if (href.charAt(0) === '#') return href.length > 1 ? href.slice(1) : '';
        let u;
        try { u = new URL(href, window.location.href); } catch (e) { return ''; }
        if (!u.hash || u.hash.length < 2) return '';
        if (u.origin !== window.location.origin) return '';
        // "/", "/index.html" y "" son la misma pagina.
        const normalizar = (ruta) => ruta.replace(/index\.html$/, '') || '/';
        if (normalizar(u.pathname) !== normalizar(window.location.pathname)) return '';
        return decodeURIComponent(u.hash.slice(1));
    }

    // 2. SCROLL SUAVE PARA EL MENÚ Y ENLACES (Offset corregido)
    const menuToggle = document.getElementById('menu-toggle');
    const menuLinks = document.querySelectorAll('.menu-list a, a[href*="#"]');
    menuLinks.forEach(link => {
        link.addEventListener('click', (event) => {
            const ancla = anclaDeEstaPagina(link);
            if (ancla) {
                event.preventDefault();
                if (menuToggle && menuToggle.checked) {
                    menuToggle.checked = false;
                }
                // Que el #hash quede en la barra de direcciones, para que
                // la persona pueda copiar el link de la seccion.
                if (window.history && window.history.replaceState) {
                    window.history.replaceState(null, '', '#' + ancla);
                }

                if (goToBloque(ancla)) return;

                const targetElement = document.getElementById(ancla);
                if (targetElement) {
                    const header = document.querySelector('.main-header');
                    const headerHeight = header ? header.offsetHeight : 0;
                    const elementPosition = targetElement.getBoundingClientRect().top;
                    const offsetPosition = elementPosition + window.pageYOffset - headerHeight;

                    window.scrollTo({
                        top: offsetPosition,
                        behavior: 'smooth'
                    });
                }
            }
        });
    });

    // 3. APARICIÓN PROGRESIVA (Intersection Observer)
    const elementsToFadeIn = document.querySelectorAll('.fade-in-element');
    const fadeInObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-visible');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1 });
    elementsToFadeIn.forEach(element => fadeInObserver.observe(element));

    // 4. LAZY-LOAD IFRAMES
    // --- Formulario de Consultas: carga individual al acercarse ---
    const consultasIframe = document.querySelector('iframe.lazy-iframe:not(.lazy-iframe-formaciones)');
    if (consultasIframe) {
        const consultasObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.src = entry.target.dataset.src;
                    observer.unobserve(entry.target);
                }
            });
        }, { rootMargin: '300px 0px' });
        consultasObserver.observe(consultasIframe);
    }

    // --- Formularios de Formaciones: cargan todos al llegar a Júpiter ---
    const jupiterSection = document.getElementById('construccion-jupiter');
    if (jupiterSection) {
        const formacionesObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    document.querySelectorAll('iframe.lazy-iframe-formaciones').forEach(iframe => {
                        if (!iframe.src) iframe.src = iframe.dataset.src;
                    });
                    observer.unobserve(entry.target);
                }
            });
        }, { rootMargin: '200px 0px' });
        formacionesObserver.observe(jupiterSection);
    }

    // 6. FLECHITA DE "HAY MÁS PARA LEER" EN CAJAS DE TEXTO: solo se marca
    // como scrolleable la caja que realmente tiene contenido de sobra (si
    // el texto ya entra entero, no tiene sentido invitar a scrollear). Se
    // oculta apenas la persona scrollea de verdad (no con el primer evento
    // "scroll" que a veces disparan los navegadores solos al pintar la
    // página, con scrollTop en 0 — eso la ocultaba antes de que se viera).
    const scrollableBoxes = document.querySelectorAll('.subsection, .efecto-texto, .formaciones-texto');
    function marcarCajasConOverflow() {
        scrollableBoxes.forEach(box => {
            box.classList.toggle('tiene-overflow', box.scrollHeight - box.clientHeight > 10);
        });
    }
    marcarCajasConOverflow();
    setTimeout(marcarCajasConOverflow, 800); // por si la tipografía reflowea después del primer paint
    window.addEventListener('resize', marcarCajasConOverflow);
    scrollableBoxes.forEach(box => {
        box.addEventListener('scroll', function() {
            if (box.scrollTop > 4) box.classList.add('scrolling');
        }, { passive: true });
    });

    // 7. NAVEGACIÓN POR FLECHAS (Carruseles PC)
    const contenedoresCarrusel = document.querySelectorAll('.efecto-visual, .formaciones-media');
    contenedoresCarrusel.forEach(contenedor => {
        const carrusel = contenedor.querySelector('.carrusel-horizontal, .carrusel-nativo');
        const flechaIzq = contenedor.querySelector('.flecha-izq');
        const flechaDer = contenedor.querySelector('.flecha-der');

        if (carrusel && flechaIzq && flechaDer) {
            const distanciaScroll = 350;
            flechaIzq.addEventListener('click', () => {
                carrusel.scrollBy({ left: -distanciaScroll, behavior: 'smooth' });
            });
            flechaDer.addEventListener('click', () => {
                carrusel.scrollBy({ left: distanciaScroll, behavior: 'smooth' });
            });
        }
    });

    // 8. ACORDEÓN PARA ELEMENTOS <DETAILS>
    document.querySelectorAll('details').forEach((detail) => {
        detail.addEventListener('toggle', () => {
            if (detail.open) {
                detail.parentElement.querySelectorAll('details').forEach((sibling) => {
                    if (sibling !== detail) sibling.open = false;
                });
            }
        });
    });

    // 9. LLEGADA CON #HASH
    //
    // Es lo que hace el menu de cualquier OTRA pagina del sitio, y
    // cualquier link compartido a una seccion. El navegador por su cuenta
    // no puede acertar, por dos motivos distintos:
    //
    //  - Las secciones del recorrido (podcast, consultas, bios...) son
    //    bloques posicionados a mano dentro del universo. Su posicion de
    //    maquetado es el centro del track, no la posicion de scroll que
    //    pone la camara enfrente: el navegador salta siempre al mismo
    //    lugar, que no es ninguno de los que se pidio.
    //  - Las secciones de mas abajo si estan en el flujo normal, pero el
    //    navegador calcula su posicion antes de que carguen las imagenes
    //    (que son casi todas lazy y sin alto reservado): cuando cargan, la
    //    pagina crece y lo que se habia enfocado quedo mas arriba.
    //
    // Por eso se corrige dos veces: ahora y cuando termino de cargar todo.
    if (window.location.hash.length > 1) {
        const idDestino = decodeURIComponent(window.location.hash.slice(1));
        const irAlDestino = () => {
            if (goToBloque(idDestino, true)) return;
            const el = document.getElementById(idDestino);
            if (!el) return;
            const header = document.querySelector('.main-header');
            const alto = header ? header.offsetHeight : 0;
            window.scrollTo({
                top: el.getBoundingClientRect().top + window.pageYOffset - alto,
                behavior: 'auto'
            });
        };
        irAlDestino();
        window.addEventListener('load', irAlDestino, { once: true });
    }

});
