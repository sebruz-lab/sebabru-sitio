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

    // Resistencia del scroll: en vez de saltar directo a la posición que
    // marca el scroll, el recorrido persigue ese punto con un poco de
    // "peso" (lerp) — pero sobre el ÚNICO número que gobierna todo lo
    // demás (seg), no sobre la posición 2D de la cámara. Así la cámara,
    // la opacidad de los bloques y el deslizamiento interno de cada uno
    // quedan siempre sincronizados entre sí (si se amortiguaban por
    // separado, el deslizamiento terminaba antes de que el bloque
    // llegara a verse — la cámara todavía la estaba "alcanzando").
    // RESISTENCIA más chico = más pesado/lento. Por eso el recorrido tiene
    // su propio loop de rAF que sigue corriendo incluso con el scroll
    // parado, para terminar de alcanzar el objetivo.
    const RESISTENCIA = 0.035;
    let segActual = null;

    function clamp01(v) { return Math.max(0, Math.min(1, v)); }

    // Mueve la cámara del recorrido y le da a cada bloque su opacidad/escala
    // según qué tan cerca está — y, si el bloque es de los que ya traían
    // animación por --scroll-progress (imagen+texto, glifos de Neptuno/
    // Júpiter, péndulos de Mercurio/Sol), le pasa un progreso local que
    // sube de 0 a 1 a medida que la cámara "llega" a ese bloque y se queda
    // en 1 al pasarlo de largo.
    function frameRecorrido() {
        if (!escenaTrack || NB === 0) return;
        const scrollable = escenaTrack.offsetHeight - window.innerHeight;
        const p = scrollable > 0 ? clamp01(-escenaTrack.getBoundingClientRect().top / scrollable) : 0;
        const segCrudo = p * (NB - 1);

        if (segActual === null) segActual = segCrudo;
        segActual += (segCrudo - segActual) * RESISTENCIA;
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
    if (escenaTrack) {
        (function loopRecorrido() {
            frameRecorrido();
            requestAnimationFrame(loopRecorrido);
        })();
    }

    // Lleva la cámara del recorrido a un bloque puntual (usado por los
    // links internos de más abajo). Devuelve false si el id no es un
    // bloque del recorrido, para que el link siga su comportamiento normal.
    function goToBloque(id) {
        if (!escenaTrack) return false;
        const idx = BLOQUES.findIndex(b => b.id === id);
        if (idx < 0) return false;
        const scrollable = escenaTrack.offsetHeight - window.innerHeight;
        window.scrollTo({
            top: escenaTrack.offsetTop + scrollable * (idx / (NB - 1)),
            behavior: 'smooth'
        });
        return true;
    }

    // Al tocar/scrollear el texto de un bloque del recorrido, la cámara se
    // alinea suavemente a la posición final de ese bloque — cada vez, no
    // solo la primera (probando qué tan bien se siente así).
    if (escenaTrack) {
        escenaTrack.querySelectorAll('.efecto-texto').forEach(caja => {
            function alinearCamara() {
                const bloqueEl = caja.closest('.bloque');
                if (bloqueEl && bloqueEl.id) goToBloque(bloqueEl.id);
            }
            caja.addEventListener('wheel', alinearCamara, { passive: true });
            caja.addEventListener('touchstart', alinearCamara, { passive: true });
        });
    }

    // 2. SCROLL SUAVE PARA EL MENÚ Y ENLACES (Offset corregido)
    const menuToggle = document.getElementById('menu-toggle');
    const menuLinks = document.querySelectorAll('.menu-list a, a[href^="#"]');
    menuLinks.forEach(link => {
        link.addEventListener('click', (event) => {
            const targetId = link.getAttribute('href');
            if (targetId && targetId.startsWith('#') && targetId.length > 1) {
                event.preventDefault();
                if (menuToggle && menuToggle.checked) {
                    menuToggle.checked = false;
                }

                if (goToBloque(targetId.slice(1))) return;

                const targetElement = document.querySelector(targetId);
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

    // 9. FLECHA DE INACTIVIDAD: si la persona queda 5s sin scrollear,
    // aparece una flecha sutil invitando a seguir. Se oculta apenas
    // vuelve a haber scroll, y no se muestra si ya llegó al final.
    const idleHint = document.getElementById('scroll-idle-hint');
    if (idleHint) {
        let idleTimer = null;
        function llegoAlFinal() {
            return window.innerHeight + window.pageYOffset >= document.body.scrollHeight - 10;
        }
        function mostrarHint() {
            idleTimer = null;
            if (!llegoAlFinal()) idleHint.classList.add('visible');
        }
        function reiniciarIdleTimer() {
            idleHint.classList.remove('visible');
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(mostrarHint, 5000);
        }
        ['scroll', 'wheel', 'touchmove', 'touchstart', 'keydown'].forEach(evt => {
            window.addEventListener(evt, reiniciarIdleTimer, { passive: true });
        });
        reiniciarIdleTimer();
    }

});
