// El markup del formulario de inscripcion a las formaciones.
//
// Una sola copia para las cinco paginas que lo muestran: las cuatro de
// /formaciones/ (intro, lectura, seminarios3, transitos) y /programa/, que
// lleva los cuatro juntos, uno debajo de cada curso. Antes estaba escrito a
// mano en cada pagina; con cinco copias, un arreglo habria que hacerlo cinco
// veces y la quinta se olvida.
//
// Cada pagina escribe solo el hueco:
//
//     <div class="inscripcion" data-form-id="intro27"></div>
//
// y inscripcion.js lo llena con esto.
//
// POR QUE LOS ID LLEVAN EL CURSO DE SUFIJO (inp-nombre-intro27)
// Porque en /programa/ hay cuatro formularios en la misma pagina. Un id
// repetido hace que <label for="inp-nombre"> enfoque siempre el campo del
// primer formulario: la persona toca la etiqueta del tercero y le escribe al
// de arriba sin enterarse. Los id quedan solo para eso, para las etiquetas y
// el aria-controls del buscador de lugares; la logica busca cada campo por su
// data-campo, que no necesita ser unico.
//
// Sin comillas tipograficas en el HTML que sale de aca: rompen los atributos
// (ver CLAUDE.md).

const OPCIONES_CONOCIMIENTOS = [
    'Sí, estudié con ustedes',
    'Sí, estudié en otra escuela',
    'No tengo estudios formales pero sí tengo conocimientos',
    'No tengo conocimientos',
];

const OPCIONES_MODALIDAD = [
    ['Virtual por Zoom', 'Virtual, por Zoom'],
    ['Presencial en Villa de las Rosas', 'Presencial, en Villa de las Rosas'],
    ['A mi ritmo', 'A mi ritmo'],
];

const OPCIONES_PAGO = [
    'En un solo pago',
    'Por semestre, en dos cuotas',
    'En 10 cuotas mensuales',
];

function opciones(lista) {
    return lista.map((o) => {
        const valor = Array.isArray(o) ? o[0] : o;
        const texto = Array.isArray(o) ? o[1] : o;
        return '<option value="' + valor + '">' + texto + '</option>';
    }).join('\n                        ');
}

// formId      el cursoId del servidor (intro27, lectura27, pluton27, transitos27)
// opts.titulo que dice el encabezado del formulario
// opts.nombre como se llama en los eventos de Analytics (por defecto, el formId)
export function crearFormulario(formId, opts) {
    const o = opts || {};
    const titulo = o.titulo || 'Inscripciones abiertas';
    const nombre = o.nombre || formId;
    const id = (base) => base + '-' + formId;

    return `
    <div class="form-wrap">
        <h3 class="titulo-form">${titulo}</h3>
        <div class="error-msg"></div>

        <form data-form-id="${formId}" data-nombre="${nombre}">

            <div class="form-group">
                <label for="${id('inp-nombre')}">Nombre y apellido</label>
                <input type="text" id="${id('inp-nombre')}" data-campo="nombre" maxlength="200" autocomplete="name" required>
            </div>

            <div class="form-group">
                <label for="${id('inp-telefono')}">Número de teléfono</label>
                <input type="tel" id="${id('inp-telefono')}" data-campo="telefono" maxlength="50" autocomplete="tel" required>
            </div>

            <div class="form-group">
                <label for="${id('inp-email')}">Dirección de mail</label>
                <input type="email" id="${id('inp-email')}" data-campo="email" maxlength="200" autocomplete="email" required>
            </div>

            <!-- Los tres datos de nacimiento son opcionales: quien ya curso
                 con nosotros no los vuelve a cargar. Si los pone, le llega la
                 carta natal en PDF con el mail de bienvenida. -->
            <div class="form-group">
                <label for="${id('inp-fecha-nacimiento')}">Fecha de nacimiento <span class="opcional">(solo si no tengo tus datos; formato DD/MM/AAAA)</span></label>
                <input type="text" id="${id('inp-fecha-nacimiento')}" data-campo="fecha" placeholder="DD/MM/AAAA" maxlength="30" inputmode="numeric" autocomplete="bday" title="Por ejemplo 05/03/1990">
            </div>

            <div class="form-group">
                <label for="${id('inp-hora-nacimiento')}">Hora de nacimiento <span class="opcional">(si no la sabés exacta, poné la más aproximada)</span></label>
                <input type="text" id="${id('inp-hora-nacimiento')}" data-campo="hora" inputmode="numeric" placeholder="HH:MM" maxlength="20" autocomplete="off">
            </div>

            <div class="form-group campo-lugar">
                <label for="${id('inp-lugar-nacimiento')}">Lugar de nacimiento <span class="opcional">(empezá a escribir la ciudad o el pueblo y elegilo de la lista)</span></label>
                <input type="text" id="${id('inp-lugar-nacimiento')}" data-campo="lugar" maxlength="200" autocomplete="off"
                    role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id('sugerencias-lugar')}">
                <ul id="${id('sugerencias-lugar')}" class="sugerencias" role="listbox" hidden></ul>
            </div>

            <div class="form-group">
                <label for="${id('inp-conocimientos')}">¿Tenés conocimientos astrológicos?</label>
                <select id="${id('inp-conocimientos')}" data-campo="conocimientos" required>
                    <option value="" selected disabled>Elegí una opción</option>
                        ${opciones(OPCIONES_CONOCIMIENTOS)}
                </select>
            </div>

            <div class="form-group">
                <label for="${id('inp-modalidad')}">¿Cómo te gustaría cursar?</label>
                <select id="${id('inp-modalidad')}" data-campo="modalidad" required>
                    <option value="" selected disabled>Elegí una opción</option>
                        ${opciones(OPCIONES_MODALIDAD)}
                </select>
            </div>

            <div class="form-group">
                <label for="${id('inp-forma-pago')}">¿De qué forma vas a abonar?</label>
                <select id="${id('inp-forma-pago')}" data-campo="formaPago" required>
                    <option value="" selected disabled>Elegí una opción</option>
                        ${opciones(OPCIONES_PAGO)}
                </select>
            </div>

            <!-- EL CUPON
                 Opcional, y el formulario se manda igual si no valida: lo que
                 escribio queda anotado en el padron con la marca de que no
                 validó, y lo mira Seba. Las formaciones no se cobran en el
                 sitio, asi que esto no baja ningun precio solo: el descuento
                 lo aplica Clari al cotizar. El cartel es para que quien tiene
                 un codigo sepa, antes de mandar, que es de verdad. -->
            <div class="form-group form-cupon">
                <label for="${id('inp-codigo')}">¿Tenés un código de descuento?</label>
                <div class="cupon-fila">
                    <input type="text" id="${id('inp-codigo')}" data-campo="codigoDescuento"
                           maxlength="40" autocomplete="off" spellcheck="false"
                           placeholder="Si no tenés, dejalo vacío">
                    <button type="button" class="btn-cupon">Aplicar</button>
                </div>
                <p class="cupon-msg" role="status" aria-live="polite"></p>
            </div>

            <!-- Viene desmarcado a proposito: la confirmacion de la
                 inscripcion llega igual, esto es solo para la newsletter. -->
            <label class="form-novedades" for="${id('inp-novedades')}">
                <input type="checkbox" id="${id('inp-novedades')}" data-campo="novedades">
                <span>Quiero recibir contenidos astrológicos gratuitos por mail. Me puedo dar de baja cuando quiera. <a href="/privacidad/" target="_blank" rel="noopener noreferrer">Cómo cuidamos tus datos</a>.</span>
            </label>

            <!-- La trampa para bots. Fuera de la pantalla, con su etiqueta,
                 para que un lector de pantalla la anuncie y una persona no la
                 complete por error. -->
            <div class="campo-trampa" aria-hidden="true">
                <label for="${id('inp-hp')}">No completar</label>
                <input type="text" id="${id('inp-hp')}" data-campo="hp" name="website" tabindex="-1" autocomplete="off">
            </div>

            <div class="captcha-wrap" style="display:none; margin: 4px 0 14px;"></div>

            <button type="submit" class="btn-enviar">
                <i class="fa-solid fa-paper-plane"></i> Enviar mi inscripción
            </button>

            <!-- Aparece solo si el envio pasa de tres segundos, que es el
                 arranque en frio de la funcion y le toca a quien manda el
                 primer formulario del dia. Sin esto ve un boton quieto y
                 recarga. No es un error: no va en la caja de errores. -->
            <p class="aviso-tarda">Estamos guardando tus datos, no cierres esta ventana.</p>
        </form>
    </div>

    <div class="listo">
        <span class="icono-listo"><i class="fa-solid fa-circle-check"></i></span>
        <p class="aviso-listo">¡Listo! Ya tengo tus datos. Revisá tu casilla: te mandé un mail con la confirmación y los pasos que siguen.</p>
        <p>Cualquier duda podés escribirle a Clari por <a href="https://wa.me/5493544559877" target="_blank" rel="noopener noreferrer">WhatsApp</a>.</p>
    </div>
`;
}
