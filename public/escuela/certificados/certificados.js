// Estructura de datos de egresados por curso.
// Para sumar un curso nuevo: agregar un objeto mas a este array.
// Para sumar un egresado: agregar un objeto { nombre, archivo } al array "egresados" del curso.
// El PDF de cada egresado debe subirse a /escuela/certificados/pdfs/<archivo>.
const cursos = [
    {
        id: 'lectura',
        titulo: 'Lectura e Interpretacion de la Carta Natal',
        egresados: [
            { nombre: 'Ana Laura Torres Bainotti', archivo: 'certificado_ana-laura-torres-bainotti.pdf' },
            { nombre: 'Kenny Cardenas', archivo: 'certificado_kenny-cardenas.pdf' },
            { nombre: 'Luisina Castelli', archivo: 'certificado_luisina-castelli.pdf' }
        ]
    }
];

function renderCursos() {
    const contenedor = document.getElementById('lista-cursos');
    if (!contenedor) return;

    cursos.forEach(curso => {
        const section = document.createElement('section');
        section.className = 'curso-certificados fade-in-element';

        const h2 = document.createElement('h2');
        h2.textContent = curso.titulo;
        section.appendChild(h2);

        const ul = document.createElement('ul');
        ul.className = 'lista-egresados';

        curso.egresados.forEach(egresado => {
            const li = document.createElement('li');
            const a = document.createElement('a');
            a.href = `pdfs/${egresado.archivo}`;
            a.setAttribute('download', '');

            const icono = document.createElement('i');
            icono.className = 'fa-solid fa-file-pdf';
            a.appendChild(icono);
            a.appendChild(document.createTextNode(' ' + egresado.nombre));

            li.appendChild(a);
            ul.appendChild(li);
        });

        section.appendChild(ul);
        contenedor.appendChild(section);
    });
}

renderCursos();
